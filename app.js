/*!
 * ZIP Checker — UI controller
 *
 * Search path (hot path, runs hundreds of times per shift):
 *   keypress → normalize input → zipIndex.get(zip) → render cards
 * No network, no array scans. The index is a Map built once by the
 * data engine (data-worker.js) and replaced atomically on background refresh.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuration                                                       */
  /* Override any value by defining `window.ZIP_CHECKER_CONFIG = {...}`  */
  /* in a script loaded before app.js (CSP allows same-origin scripts).  */
  /* ------------------------------------------------------------------ */
  var DEFAULTS = {
    sheetId: '1CzToIFZSkV3-kB0vklv9cSU-naNpppM_c5hSz3rKkwU',
    sheetName: 'AllZips',
    /** Background re-check interval while the app is open (ms). 0 disables. */
    refreshIntervalMs: 10 * 60 * 1000,
    /** When the tab regains focus, refresh if the last check is older than this (ms). */
    refreshOnFocusAfterMs: 5 * 60 * 1000,
    /** Network timeout per data source (ms). */
    fetchTimeoutMs: 30000,
    /** Run the lookup as soon as 5 digits are typed (Enter still works). */
    autoSearchOnFiveDigits: true,
    /** Parse/index in a Web Worker (falls back to main thread automatically). */
    useWorker: true,
    /** Register the service worker (app shell offline support). */
    serviceWorker: true
  };
  var CONFIG = Object.assign({}, DEFAULTS, window.ZIP_CHECKER_CONFIG || {});
  if (!CONFIG.sources) {
    var id = encodeURIComponent(CONFIG.sheetId);
    var sheet = encodeURIComponent(CONFIG.sheetName);
    CONFIG.sources = [
      // Primary: OpenSheet (Sheets API formatted values → exact cell text).
      { name: 'OpenSheet', type: 'json', url: 'https://opensheet.elk.sh/' + id + '/' + sheet },
      // Fallback: Google's public visualization CSV endpoint (no credentials).
      { name: 'Google Sheets', type: 'csv',
        url: 'https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + sheet }
    ];
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  var zipIndex = null;        // Map<string, Array<{zip,state,client,timings,preset}>>
  var meta = null;            // { count, zipCount, checkedAt, fetchedAt, ... }
  var refreshing = false;
  var lastError = null;       // null | 'offline' | 'failed'
  var pendingZip = '';        // search typed before the DB was ready
  var shownZip = '';          // ZIP whose result is currently displayed
  var sendToEngine = function () {};
  var EMPTY = [];

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */
  var $ = function (id) { return document.getElementById(id); };
  var form = $('search-form');
  var input = $('zip-input');
  var clearBtn = $('clear-btn');
  var resultsEl = $('results');
  var srStatus = $('sr-status');
  var statusEl = $('db-status');
  var statusLabel = $('db-label');
  var statusMeta = $('db-meta');
  var refreshBtn = $('db-refresh');
  var cardTpl = $('tpl-card');

  var numberFmt = new Intl.NumberFormat('en-US');
  var stampFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });

  /* Tiny safe DOM builder: text is always assigned via textContent. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Input handling                                                      */
  /* ------------------------------------------------------------------ */

  /** Agent input → digits only, max 5. Never pads: "123" stays invalid. */
  function cleanInput(value) {
    return String(value == null ? '' : value).replace(/\D/g, '').slice(0, 5);
  }

  function focusInput(select) {
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (select && input.value) input.select();
  }

  function announce(text) {
    // Clear first so repeated identical messages are re-announced.
    srStatus.textContent = '';
    window.requestAnimationFrame(function () { srStatus.textContent = text; });
  }

  /* ------------------------------------------------------------------ */
  /* Search (hot path)                                                   */
  /* ------------------------------------------------------------------ */
  function search(raw) {
    var zip = cleanInput(raw);

    if (!zip) {
      renderInvalid('Please enter a 5-digit ZIP code.');
      return;
    }
    if (zip.length !== 5) {
      renderInvalid('Please enter a valid 5-digit ZIP code.');
      return;
    }
    input.removeAttribute('aria-invalid');

    if (!zipIndex) {
      pendingZip = zip;
      if (lastError) renderLoadError();
      else renderWaiting(zip);
      return;
    }

    pendingZip = '';
    var matches = zipIndex.get(zip) || EMPTY; // O(1) indexed lookup
    if (matches.length) renderFound(zip, matches);
    else renderOutOfArea(zip);
    focusInput(true);
  }

  function clearAll() {
    input.value = '';
    input.removeAttribute('aria-invalid');
    pendingZip = '';
    shownZip = '';
    renderPlaceholder();
    announce('Cleared.');
    focusInput(false);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  function show(node) {
    resultsEl.replaceChildren(node);
  }

  function banner(kind, icon, title, textNodes, zip) {
    var b = el('div', 'banner banner--' + kind + ' appear');
    var i = el('div', 'banner__icon', icon);
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    var body = el('div', 'banner__body');
    body.appendChild(el('p', 'banner__title', title));
    var p = el('p', 'banner__text');
    for (var k = 0; k < textNodes.length; k++) {
      var t = textNodes[k];
      p.appendChild(typeof t === 'string' ? document.createTextNode(t) : t);
    }
    body.appendChild(p);
    b.appendChild(body);
    if (zip) {
      var z = el('div', 'banner__zip', zip);
      z.setAttribute('aria-label', 'ZIP ' + zip.split('').join(' '));
      b.appendChild(z);
    }
    return b;
  }

  function setField(dd, value) {
    if (value) {
      dd.textContent = value;
    } else {
      dd.textContent = 'N/A';
      dd.classList.add('na');
    }
  }

  var TZ_TOKEN = /^\(?[A-Z]{2,5}\)?$/;
  function renderTimings(dd, value) {
    if (!value) { setField(dd, ''); return; }
    // Timings look like "|Mon - Fri 4pm till 7pm |CST|" → chips per segment.
    var parts = value.split('|');
    var chips = el('span', 'chips');
    var count = 0;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      if (!seg) continue;
      chips.appendChild(el('span', TZ_TOKEN.test(seg) ? 'chip chip--tz' : 'chip', seg));
      count++;
    }
    if (!count) { setField(dd, ''); return; }
    dd.setAttribute('aria-label', value.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim());
    dd.appendChild(chips);
  }

  function buildCard(m, i, total) {
    var node = cardTpl.content.firstElementChild.cloneNode(true);
    var num = node.querySelector('.result-card__num');
    if (total > 1) {
      num.textContent = String(i + 1);
      num.setAttribute('aria-label', 'Client ' + (i + 1) + ' of ' + total);
    } else {
      num.remove();
    }
    setField(node.querySelector('.result-card__client'), m.client);
    setField(node.querySelector('.f-zip'), m.zip);
    setField(node.querySelector('.f-state'), m.state);
    renderTimings(node.querySelector('.f-timings'), m.timings);
    setField(node.querySelector('.f-preset'), m.preset);
    return node;
  }

  function renderFound(zip, matches) {
    var n = matches.length;
    var noun = n === 1 ? 'Client' : 'Clients';
    var frag = document.createDocumentFragment();
    frag.appendChild(banner('ok', '✓', 'ZIP Verified', [
      'Your ZIP is good to go on ', el('strong', null, '"' + n + '"'), ' ' + noun
    ], zip));
    var grid = el('div', 'cards');
    grid.setAttribute('role', 'list');
    for (var i = 0; i < n; i++) {
      var card = buildCard(matches[i], i, n);
      card.setAttribute('role', 'listitem');
      card.classList.add('appear');
      grid.appendChild(card);
    }
    frag.appendChild(grid);
    show(frag);
    shownZip = zip;

    var names = [];
    for (var j = 0; j < n; j++) names.push(matches[j].client || 'N/A');
    announce('ZIP ' + zip + ' verified. Good to go on ' + n + ' ' + noun + ': ' + names.join(', ') + '.');
  }

  function renderOutOfArea(zip) {
    show(banner('none', '✕', 'Out of Area', [
      el('strong', null, 'No result found. '), 'No client coverage found for this ZIP.'
    ], zip));
    shownZip = zip;
    announce('ZIP ' + zip + ': no result found. Out of area.');
  }

  function renderInvalid(message) {
    input.setAttribute('aria-invalid', 'true');
    show(banner('warn', '!', 'Invalid ZIP', [message]));
    shownZip = '';
    announce('Invalid ZIP. ' + message);
    focusInput(true);
  }

  function renderWaiting(zip) {
    var b = banner('info', '…', 'Initializing ZIP Database…', [
      'Your search for ', el('strong', null, zip), ' will run automatically as soon as the database is ready.'
    ]);
    b.querySelector('.banner__icon').classList.add('spin-dot');
    show(b);
    shownZip = '';
    announce('ZIP database is still loading. Your search will run automatically.');
  }

  function renderLoadError() {
    var b = banner('error', '!', 'Unable to load ZIP database.', [
      'Please check your internet connection and reload.'
    ]);
    var retry = el('button', 'btn btn--primary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', function () { requestRefresh('manual'); focusInput(false); });
    b.appendChild(retry);
    show(b);
    shownZip = '';
    announce('Unable to load ZIP database. Please check your internet connection and reload.');
  }

  function renderPlaceholder() {
    var p = el('div', 'placeholder' + (zipIndex || lastError ? '' : ' placeholder--loading'));
    p.id = 'placeholder';
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '40');
    svg.setAttribute('height', '40');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z');
    svg.appendChild(path);
    p.appendChild(svg);
    p.appendChild(el('p', null, zipIndex || lastError
      ? 'Type a ZIP code to check client coverage.'
      : 'Initializing ZIP Database… You can start typing — the search runs as soon as it is ready.'));
    show(p);
  }

  /* ------------------------------------------------------------------ */
  /* Database status indicator                                           */
  /* ------------------------------------------------------------------ */
  var srDb = document.createElement('div');
  srDb.className = 'sr-only';
  srDb.setAttribute('role', 'status');
  srDb.setAttribute('aria-live', 'polite');
  document.body.appendChild(srDb);
  var lastDbAnnouncement = '';

  function updateStatus() {
    var state, label;
    if (!zipIndex) {
      if (lastError) { state = 'error'; label = 'Unable to load ZIP database'; }
      else { state = 'loading'; label = 'Initializing ZIP Database…'; }
    } else if (refreshing) {
      state = 'updating'; label = 'Updating Data…';
    } else if (lastError === 'offline') {
      state = 'offline'; label = 'Offline — Using Cached Data';
    } else if (lastError === 'failed') {
      state = 'stale'; label = 'Update Failed — Using Cached Data';
    } else {
      state = 'ready'; label = 'ZIP Database Ready';
    }
    statusEl.setAttribute('data-state', state);
    statusLabel.textContent = label;
    refreshBtn.setAttribute('aria-busy', refreshing ? 'true' : 'false');

    var bits = [];
    if (meta) {
      var t = meta.checkedAt || meta.fetchedAt;
      if (t) bits.push('Updated: ' + stampFmt.format(new Date(t)));
      if (meta.count != null) bits.push('Records: ' + numberFmt.format(meta.count));
    }
    statusMeta.textContent = bits.join(' · ');
    statusEl.title = label + (bits.length ? '\n' + bits.join('\n') : '');

    // Announce only meaningful transitions (not every "Updating…").
    if (state !== 'updating' && label !== lastDbAnnouncement) {
      lastDbAnnouncement = label;
      srDb.textContent = label;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Data engine wiring                                                  */
  /* ------------------------------------------------------------------ */
  function installIndex(index, newMeta) {
    var hadData = !!zipIndex;
    zipIndex = index;
    meta = newMeta;
    updateStatus();

    if (pendingZip) {
      var z = pendingZip;
      pendingZip = '';
      if (cleanInput(input.value) === z) search(z);
    } else if (shownZip) {
      // Data changed underneath a visible result: re-render silently.
      var matches = zipIndex.get(shownZip) || EMPTY;
      var keepFocus = document.activeElement === input;
      if (matches.length) renderFound(shownZip, matches); else renderOutOfArea(shownZip);
      if (keepFocus) focusInput(false);
    } else if (!hadData && document.getElementById('placeholder')) {
      renderPlaceholder();
    }
  }

  function onEngineMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'cache':
        installIndex(msg.index, msg.meta);
        break;
      case 'no-cache':
        updateStatus();
        break;
      case 'refresh-start':
        refreshing = true;
        updateStatus();
        break;
      case 'data':
        refreshing = false;
        lastError = null;
        installIndex(msg.index, msg.meta);
        break;
      case 'unchanged':
        refreshing = false;
        lastError = null;
        meta = msg.meta;
        updateStatus();
        break;
      case 'refresh-error':
        refreshing = false;
        lastError = msg.offline ? 'offline' : 'failed';
        updateStatus();
        if (window.console) console.warn('[ZIP Checker] Data refresh failed:', msg.message);
        if (!zipIndex) {
          if (pendingZip || document.getElementById('placeholder')) renderLoadError();
        }
        break;
      case 'cache-error':
        if (window.console) console.warn('[ZIP Checker] Cache:', msg.message);
        break;
    }
  }

  function requestRefresh(reason) {
    if (refreshing) return;
    if (!zipIndex) { lastError = null; updateStatus(); renderPlaceholder(); }
    sendToEngine({ type: 'refresh', reason: reason });
  }

  function startInlineEngine(initMsg) {
    function boot() {
      var engine = window.ZipEngine.create(function (m) { onEngineMessage(m); });
      sendToEngine = function (m) { engine.handle(m); };
      engine.handle(initMsg);
    }
    if (window.ZipEngine) { boot(); return; }
    var s = document.createElement('script');
    s.src = 'data-worker.js';
    s.onload = boot;
    s.onerror = function () {
      lastError = 'failed';
      updateStatus();
      renderLoadError();
    };
    document.head.appendChild(s);
  }

  function startEngine() {
    var initMsg = {
      type: 'init',
      config: { sources: CONFIG.sources, timeoutMs: CONFIG.fetchTimeoutMs }
    };
    if (CONFIG.useWorker && typeof Worker !== 'undefined') {
      try {
        var worker = new Worker('data-worker.js');
        var alive = false;
        worker.onmessage = function (e) { alive = true; onEngineMessage(e.data); };
        worker.onerror = function (ev) {
          if (alive) return;
          if (ev && ev.preventDefault) ev.preventDefault();
          worker.terminate();
          startInlineEngine(initMsg);
        };
        sendToEngine = function (m) { worker.postMessage(m); };
        worker.postMessage(initMsg);
        return;
      } catch (_) { /* fall through to inline engine */ }
    }
    startInlineEngine(initMsg);
  }

  /* ------------------------------------------------------------------ */
  /* Live timezone clocks (Intl handles DST automatically)               */
  /* ------------------------------------------------------------------ */
  function startClocks() {
    var clocks = [];
    var nodes = document.querySelectorAll('.clock[data-tz]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var tz = node.getAttribute('data-tz');
      try {
        clocks.push({
          fixedAbbr: node.getAttribute('data-abbr'),
          timeEl: node.querySelector('.clock__time'),
          dateEl: node.querySelector('.clock__date'),
          abbrEl: node.querySelector('.clock__abbr'),
          fTime: new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
          }),
          fDate: new Intl.DateTimeFormat('en-US', {
            timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
          }),
          fAbbr: new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }),
          t: '', d: '', a: ''
        });
      } catch (e) {
        node.querySelector('.clock__time').textContent = 'Unavailable';
      }
    }

    function tzAbbr(c, now) {
      if (c.fixedAbbr) return c.fixedAbbr;
      var parts = c.fAbbr.formatToParts(now);
      for (var k = 0; k < parts.length; k++) if (parts[k].type === 'timeZoneName') return parts[k].value;
      return '';
    }

    function tick() {
      var now = new Date();
      for (var j = 0; j < clocks.length; j++) {
        var c = clocks[j];
        var t = c.fTime.format(now);
        if (t !== c.t) { c.t = t; c.timeEl.textContent = t; }
        var d = c.fDate.format(now);
        if (d !== c.d) { c.d = d; c.dateEl.textContent = d; }
        if (now.getSeconds() === 0 || !c.a) { // DST abbreviation only changes on minute boundaries
          var a = tzAbbr(c, now);
          if (a !== c.a) { c.a = a; c.abbrEl.textContent = a; }
        }
      }
      // Align to the next wall-clock second to avoid drift/skips.
      setTimeout(tick, 1000 - (Date.now() % 1000) + 10);
    }
    tick();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    search(input.value);
  });

  input.addEventListener('input', function () {
    var cleaned = cleanInput(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    if (input.getAttribute('aria-invalid') && cleaned.length === 5) input.removeAttribute('aria-invalid');
    if (CONFIG.autoSearchOnFiveDigits && cleaned.length === 5) search(cleaned);
  });

  clearBtn.addEventListener('click', clearAll);
  refreshBtn.addEventListener('click', function () { requestRefresh('manual'); });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // never hijack browser shortcuts (Ctrl/Cmd+F5, etc.)
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      clearAll();
      return;
    }
    // Typing a digit anywhere jumps straight into the ZIP box.
    if (/^[0-9]$/.test(e.key) && e.target !== input) {
      var tag = e.target && e.target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !(e.target && e.target.isContentEditable)) {
        input.value = '';
        input.focus();
      }
    }
  });

  window.addEventListener('online', function () { requestRefresh('online'); });
  window.addEventListener('offline', function () {
    if (zipIndex && !refreshing) { lastError = 'offline'; updateStatus(); }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !zipIndex || !meta) return;
    var last = meta.checkedAt || 0;
    if (Date.now() - last > CONFIG.refreshOnFocusAfterMs) requestRefresh('focus');
  });
  if (CONFIG.refreshIntervalMs > 0) {
    setInterval(function () {
      if (document.visibilityState === 'visible') requestRefresh('interval');
    }, CONFIG.refreshIntervalMs);
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  updateStatus();
  renderPlaceholder();
  focusInput(false);
  startEngine();     // preload DB immediately (cache first, then network)
  startClocks();

  if (CONFIG.serviceWorker && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        if (window.console) console.warn('[ZIP Checker] Service worker registration failed:', err);
      });
    });
  }

  // Test/debug hook (read-only).
  window.__zipChecker = {
    lookup: function (zip) { return zipIndex ? (zipIndex.get(cleanInput(zip)) || EMPTY) : null; },
    get ready() { return !!zipIndex; },
    get meta() { return meta; }
  };
})();
