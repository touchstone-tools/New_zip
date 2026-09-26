/*!
 * ZIP Checker — data engine
 *
 * Downloads the AllZips worksheet, normalizes rows, builds the
 * Map<zip, records[]> index and persists the dataset in IndexedDB
 * (stale-while-revalidate).
 *
 * This file runs in two modes:
 *   1. As a dedicated Web Worker (preferred): keeps JSON parsing, indexing and
 *      IndexedDB I/O off the UI thread.
 *   2. As a classic <script> on the main thread (fallback when Workers are
 *      unavailable, e.g. some file:// contexts). It then exposes
 *      `self.ZipEngine.create(postMessage)`.
 *
 * The engine is READ-ONLY with respect to the Google Sheet.
 */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 2; // bump when the stored record shape changes
  var DB_NAME = 'zip-checker';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var DATA_KEY = 'dataset';
  var META_KEY = 'meta';
  var CHANNEL_NAME = 'zip-checker-sync';

  /* ------------------------------------------------------------------ */
  /* Normalization                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Normalize any spreadsheet ZIP value into a 5-digit string.
   * Sheets often stores ZIPs as numbers, so "06082" arrives as "6082" and
   * must be left-padded. ZIP+4 values ("06082-1234") keep the first 5 digits.
   * Returns "" when no usable ZIP is present.
   */
  function normalizeZip(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return '';
    var m = s.match(/\d+/); // first run of digits (handles "6082.0", "CT 6082", "6082-1234")
    if (!m) return '';
    var digits = m[0];
    if (digits.length > 5) digits = digits.slice(0, 5);
    else digits = digits.padStart(5, '0');
    return digits === '00000' ? '' : digits;
  }

  function clean(value) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  // Header name -> internal field. Matching is case/whitespace-insensitive,
  // but only for the real spreadsheet columns (no invented fields).
  var HEADER_MAP = {
    'zip': 'zip',
    'zipstate': 'zipState',
    'state': 'state',
    'good to go on client': 'client',
    'timings': 'timings',
    'transfer to preset': 'preset'
  };

  function headerKey(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /* String interning keeps memory low: ~20k rows share a few hundred
     distinct client/timing/preset strings. */
  function makeInterner() {
    var pool = new Map();
    return function (s) {
      var hit = pool.get(s);
      if (hit !== undefined) return hit;
      pool.set(s, s);
      return s;
    };
  }

  /**
   * Convert an array of objects keyed by header name into compact rows:
   * [zip, state, client, timings, preset]
   */
  function rowsFromObjects(list) {
    if (!Array.isArray(list)) throw new Error('Unexpected data format');
    var intern = makeInterner();
    var out = [];
    var skipped = 0;
    var keyCache = new Map(); // raw header -> field (or null)

    for (var i = 0; i < list.length; i++) {
      var obj = list[i];
      if (!obj || typeof obj !== 'object') { skipped++; continue; }
      var f = { zip: '', zipState: '', state: '', client: '', timings: '', preset: '' };
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        var field = keyCache.get(k);
        if (field === undefined) {
          field = HEADER_MAP[headerKey(k)] || null;
          keyCache.set(k, field);
        }
        if (field && !f[field]) f[field] = obj[k];
      }
      var zip = normalizeZip(f.zip) || normalizeZip(f.zipState);
      if (!zip) { skipped++; continue; }
      out.push([
        zip,
        intern(clean(f.state)),
        intern(clean(f.client)),
        intern(clean(f.timings)),
        intern(clean(f.preset))
      ]);
    }
    return { rows: out, skipped: skipped };
  }

  /** Fast RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var i = 0;
    var n = text.length;
    var inQuotes = false;
    if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        var next = text.indexOf('"', i);
        if (next === -1) { field += text.slice(i); i = n; continue; }
        field += text.slice(i, next); i = next; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        row.push(field); field = '';
        rows.push(row); row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function rowsFromCSV(text) {
    var table = parseCSV(text);
    if (!table.length) throw new Error('Empty CSV');
    var header = table[0];
    var list = new Array(table.length - 1);
    for (var r = 1; r < table.length; r++) {
      var o = {};
      var cells = table[r];
      for (var c = 0; c < header.length; c++) {
        if (header[c]) o[header[c]] = cells[c];
      }
      list[r - 1] = o;
    }
    return rowsFromObjects(list);
  }

  /** 32-bit FNV-1a over the compact rows; used to detect sheet changes. */
  function hashRows(rows) {
    var h = 0x811c9dc5;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      for (var c = 0; c < row.length; c++) {
        var s = row[c];
        for (var i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        h ^= 0x1f; h = Math.imul(h, 0x01000193); // field separator
      }
      h ^= 0x1e; h = Math.imul(h, 0x01000193);   // row separator
    }
    return (h >>> 0).toString(16) + ':' + rows.length;
  }

  /**
   * Build the lookup index: Map<"5-digit zip", Array<record>>.
   * Exact duplicate rows (identical in every column) are collapsed.
   */
  function buildIndex(rows) {
    var index = new Map();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var rec = { zip: r[0], state: r[1], client: r[2], timings: r[3], preset: r[4] };
      var list = index.get(r[0]);
      if (!list) { index.set(r[0], [rec]); continue; }
      var dup = false;
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (e.client === rec.client && e.state === rec.state &&
            e.timings === rec.timings && e.preset === rec.preset) { dup = true; break; }
      }
      if (!dup) list.push(rec);
    }
    return index;
  }

  /* ------------------------------------------------------------------ */
  /* IndexedDB (tiny key/value wrapper)                                  */
  /* ------------------------------------------------------------------ */

  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(entries) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        for (var k in entries) store.put(entries[k], k);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Network                                                             */
  /* ------------------------------------------------------------------ */

  function fetchWithTimeout(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    return fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function loadFromSource(src, timeoutMs) {
    return fetchWithTimeout(src.url, timeoutMs).then(function (text) {
      var parsed;
      if (src.type === 'csv') {
        if (/^\s*</.test(text)) throw new Error('Sheet is not publicly readable');
        parsed = rowsFromCSV(text);
      } else {
        var json = JSON.parse(text);
        if (json && !Array.isArray(json) && json.error) throw new Error(String(json.error));
        parsed = rowsFromObjects(json);
      }
      if (!parsed.rows.length) throw new Error('No valid ZIP rows returned');
      parsed.source = src.name;
      return parsed;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                              */
  /* ------------------------------------------------------------------ */

  function create(post) {
    var config = { sources: [], timeoutMs: 25000 };
    var meta = null;           // { hash, count, zipCount, skipped, fetchedAt, checkedAt, source }
    var refreshing = null;     // in-flight refresh promise
    var channel = null;

    function isOnline() {
      return typeof navigator === 'undefined' || navigator.onLine !== false;
    }

    function publish(type, rows, m) {
      var t0 = Date.now();
      var index = buildIndex(rows);
      m.zipCount = index.size;
      post({ type: type, index: index, meta: m, buildMs: Date.now() - t0 });
    }

    function loadCache() {
      return Promise.all([idbGet(META_KEY), idbGet(DATA_KEY)]).then(function (res) {
        var m = res[0], data = res[1];
        if (!m || !data || m.schema !== SCHEMA_VERSION || !Array.isArray(data.rows) ||
            data.hash !== m.hash || !data.rows.length) {
          return false;
        }
        meta = m;
        publish('cache', data.rows, Object.assign({}, m));
        return true;
      }).catch(function (err) {
        post({ type: 'cache-error', message: String(err && err.message || err) });
        return false;
      });
    }

    function tryReloadFromCache(expectedHash) {
      return idbGet(META_KEY).then(function (m) {
        if (!m || m.hash !== expectedHash || (meta && meta.hash === expectedHash)) return;
        return idbGet(DATA_KEY).then(function (data) {
          if (!data || data.hash !== expectedHash) return;
          meta = m;
          publish('data', data.rows, Object.assign({}, m));
        });
      }).catch(function () { /* ignore */ });
    }

    function refresh(reason) {
      if (refreshing) return refreshing;
      post({ type: 'refresh-start', reason: reason || 'auto' });

      var sources = config.sources.slice();
      var errors = [];

      function attempt(i) {
        if (i >= sources.length) {
          var e = new Error(errors.join(' | ') || 'No data sources configured');
          e.all = true;
          return Promise.reject(e);
        }
        return loadFromSource(sources[i], config.timeoutMs).catch(function (err) {
          errors.push(sources[i].name + ': ' + (err && err.message || err));
          return attempt(i + 1);
        });
      }

      refreshing = attempt(0).then(function (parsed) {
        var now = Date.now();
        var hash = hashRows(parsed.rows);
        if (meta && meta.hash === hash) {
          meta = Object.assign({}, meta, { checkedAt: now, source: parsed.source });
          post({ type: 'unchanged', meta: Object.assign({}, meta) });
          return idbPut({ meta: meta }).catch(function () {});
        }
        var m = {
          schema: SCHEMA_VERSION,
          hash: hash,
          count: parsed.rows.length,
          skipped: parsed.skipped,
          fetchedAt: now,
          checkedAt: now,
          source: parsed.source
        };
        meta = m;
        publish('data', parsed.rows, Object.assign({}, m));
        return idbPut({ dataset: { hash: hash, rows: parsed.rows }, meta: m })
          .then(function () {
            if (channel) channel.postMessage({ type: 'updated', hash: hash });
          })
          .catch(function (err) {
            post({ type: 'cache-error', message: 'Could not save cache: ' + (err && err.message || err) });
          });
      }).catch(function (err) {
        post({
          type: 'refresh-error',
          offline: !isOnline(),
          hasData: !!meta,
          message: String(err && err.message || err)
        });
      }).finally(function () {
        refreshing = null;
      });

      return refreshing;
    }

    function init(cfg) {
      if (cfg) {
        if (Array.isArray(cfg.sources)) config.sources = cfg.sources;
        if (cfg.timeoutMs) config.timeoutMs = cfg.timeoutMs;
      }
      if (typeof BroadcastChannel !== 'undefined' && !channel) {
        try {
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.onmessage = function (e) {
            if (e.data && e.data.type === 'updated') tryReloadFromCache(e.data.hash);
          };
        } catch (_) { channel = null; }
      }
      return loadCache().then(function (hit) {
        if (!hit) post({ type: 'no-cache' });
        if (cfg && cfg.fetchOnStart === false && hit) return;
        return refresh('startup');
      });
    }

    function handle(msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'init') init(msg.config);
      else if (msg.type === 'refresh') refresh(msg.reason || 'manual');
    }

    return { handle: handle };
  }

  var api = {
    create: create,
    // Exported for tests / reuse.
    normalizeZip: normalizeZip,
    parseCSV: parseCSV,
    rowsFromObjects: rowsFromObjects,
    rowsFromCSV: rowsFromCSV,
    buildIndex: buildIndex,
    hashRows: hashRows
  };

  var isWorker = typeof WorkerGlobalScope !== 'undefined' && global instanceof WorkerGlobalScope;
  if (isWorker) {
    var engine = create(function (msg) { global.postMessage(msg); });
    global.onmessage = function (e) { engine.handle(e.data); };
  } else {
    global.ZipEngine = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
