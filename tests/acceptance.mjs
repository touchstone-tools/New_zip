// End-to-end acceptance tests (headless Chromium via Playwright).
//
//   npm install && npx playwright install chromium && npm test
//
// Set CHROME_PATH to use an existing Chromium binary instead.
// The Google Sheet endpoints are intercepted with fixtures, so the suite is
// deterministic and never touches the real sheet.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BASE_ROWS, bigDataset, toCSV } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Simulates a new deployment: when set, served index.html gets this marker.
const deploy = { marker: '' };
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (deploy.marker && file.endsWith('index.html')) {
      res.end(fs.readFileSync(file, 'utf8').replace('<body>', `<body data-deploy="${deploy.marker}">`));
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const OPENSHEET = /opensheet\.elk\.sh/;
const GVIZ = /docs\.google\.com\/spreadsheets/;

// Mutable network behaviour for the fake sheet.
const net = { mode: 'ok', rows: BASE_ROWS, delay: 0, gviz: 'fail', hits: 0 };
async function installRoutes(ctx) {
  await ctx.route(OPENSHEET, async (route) => {
    net.hits++;
    if (net.delay) await new Promise((r) => setTimeout(r, net.delay));
    if (net.mode === 'fail') return route.abort('internetdisconnected');
    if (net.mode === 'http500') return route.fulfill({ status: 500, body: 'err' });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(net.rows) });
  });
  await ctx.route(GVIZ, (route) => {
    if (net.gviz === 'ok') return route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: toCSV(net.rows) });
    route.abort('internetdisconnected');
  });
}

let passed = 0;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
  console.log(results[results.length - 1]);
}

async function searchZip(page, zip, { enter = true } = {}) {
  await page.fill('#zip-input', '');
  await page.type('#zip-input', zip);
  if (enter) await page.press('#zip-input', 'Enter');
}
const bannerTitle = (page) => page.textContent('.banner__title');
const waitReady = (page) => page.waitForFunction(() => window.__zipChecker && window.__zipChecker.ready, null, { timeout: 15000 });

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}/`;
const launchOpts = { headless: true, args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch(launchOpts);

try {
  /* ---------------- Main context (service worker blocked so routes apply) ---------------- */
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 900 } });
  await installRoutes(ctx);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await page.goto(BASE);

  await step('Preload: DB loads on startup without a search; input autofocused', async () => {
    await waitReady(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'zip-input');
    await page.waitForFunction(() => document.getElementById('db-label').textContent === 'ZIP Database Ready');
    const metaText = await page.textContent('#db-meta');
    assert.match(metaText, /Updated: .+ · Records: 10/);
    assert.equal(net.hits, 1, 'exactly one data download');
  });

  await step('Test 1 — valid ZIP shows ZIP VERIFIED + client info', async () => {
    await searchZip(page, '63010');
    assert.equal(await bannerTitle(page), 'ZIP Verified');
    assert.equal(await page.textContent('.result-card__client'), 'AMO');
    assert.equal(await page.textContent('.f-zip'), '63010');
    assert.equal(await page.textContent('.f-state'), 'MO');
    assert.equal(await page.textContent('.f-preset'), 'AMO Set');
    assert.deepEqual(await page.$$eval('.f-timings .chip', (n) => n.map((x) => x.textContent)), ['Mon - Fri 4pm till 7pm', 'CST']);
    assert.match(await page.textContent('.banner__text'), /Your ZIP is good to go on "1" Client$/);
  });

  await step('Test 2 — multiple matches: "3" Clients, all cards, duplicates collapsed', async () => {
    await searchZip(page, '91115');
    assert.match(await page.textContent('.banner__text'), /good to go on "3" Clients/);
    const clients = await page.$$eval('.result-card__client', (n) => n.map((x) => x.textContent));
    assert.deepEqual(clients, ['CA > Pasadena', 'Bath Expert', 'Glendale Water & Power']);
  });

  await step('Test 3 — "123" → Invalid ZIP', async () => {
    await searchZip(page, '123');
    assert.equal(await bannerTitle(page), 'Invalid ZIP');
    assert.match(await page.textContent('.banner__text'), /valid 5-digit ZIP/);
    assert.equal(await page.getAttribute('#zip-input', 'aria-invalid'), 'true');
  });

  await step('Empty ZIP → Invalid ZIP prompt', async () => {
    await page.fill('#zip-input', '');
    await page.click('#search-btn');
    assert.equal(await bannerTitle(page), 'Invalid ZIP');
  });

  await step('Test 4 — unknown ZIP → Out of Area', async () => {
    await searchZip(page, '99999');
    assert.equal(await bannerTitle(page), 'Out of Area');
    assert.match(await page.textContent('.banner__text'), /No result found\. No client coverage found for this ZIP\./);
  });

  await step('Test 5 — leading zeros preserved (00501, 06082, 02108 via ZipState)', async () => {
    for (const [zip, client] of [['00501', 'NY Holtsville'], ['06082', 'CT > Eversource'], ['02108', 'MA Client']]) {
      await searchZip(page, zip);
      assert.equal(await bannerTitle(page), 'ZIP Verified', zip);
      assert.equal(await page.textContent('.f-zip'), zip);
      assert.equal(await page.textContent('.banner__zip'), zip);
      assert.equal(await page.textContent('.result-card__client'), client);
    }
    await searchZip(page, '501');
    assert.equal(await bannerTitle(page), 'Invalid ZIP', 'user input is never padded');
  });

  await step('Missing fields render N/A', async () => {
    await searchZip(page, '44680');
    assert.equal(await page.textContent('.f-timings'), 'N/A');
    assert.equal(await page.textContent('.f-preset'), 'N/A');
  });

  await step('Spreadsheet values are escaped (no HTML injection)', async () => {
    await searchZip(page, '11111');
    assert.equal(await page.textContent('.result-card__client'), '<img src=x onerror="window.__xss=1">Evil');
    assert.equal(await page.$('.result-card img'), null);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  await step('Keyboard: auto-search at 5 digits, focus kept + text selected, Esc clears', async () => {
    await page.fill('#zip-input', '');
    await page.type('#zip-input', '63010'); // no Enter
    assert.equal(await bannerTitle(page), 'ZIP Verified');
    const sel = await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]);
    assert.deepEqual(sel, ['zip-input', 0, 5]);
    await page.keyboard.type('91115'); // overwrites the selected ZIP
    assert.match(await page.textContent('.banner__text'), /"3" Clients/);
    await page.keyboard.press('Escape');
    assert.equal(await page.inputValue('#zip-input'), '');
    assert.ok(await page.$('#placeholder'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'zip-input');
  });

  await step('Keyboard: digit typed with focus elsewhere jumps into ZIP box', async () => {
    await page.focus('#clear-btn');
    await page.keyboard.type('63010');
    assert.equal(await page.inputValue('#zip-input'), '63010');
    assert.equal(await bannerTitle(page), 'ZIP Verified');
  });

  await step('Paste of ZIP+4 / spaces is cleaned', async () => {
    await page.fill('#zip-input', ' 63010-1234');
    await page.press('#zip-input', 'Enter');
    assert.equal(await page.inputValue('#zip-input'), '63010');
    assert.equal(await bannerTitle(page), 'ZIP Verified');
  });

  await step('Test 7 — reload: cached data usable immediately, refresh in background', async () => {
    net.delay = 2500;
    const hitsBefore = net.hits;
    const t0 = Date.now();
    await page.reload();
    await waitReady(page);
    const readyMs = Date.now() - t0;
    assert.ok(readyMs < 2000, `ready from cache in ${readyMs} ms (network delayed 2.5 s)`);
    assert.equal(await page.textContent('#db-label'), 'Updating Data…');
    await searchZip(page, '91115');
    assert.match(await page.textContent('.banner__text'), /"3" Clients/, 'search works during refresh');
    await page.waitForFunction(() => document.getElementById('db-label').textContent === 'ZIP Database Ready', null, { timeout: 8000 });
    assert.equal(net.hits, hitsBefore + 1);
    net.delay = 0;
  });

  await step('Background refresh picks up sheet changes and re-renders visible result', async () => {
    await searchZip(page, '63010');
    net.rows = [...BASE_ROWS, { Zip: '63010', State: 'MO', 'Good to Go on Client': 'New Client', Timings: 'Mon', 'Transfer to Preset': 'New Set' }];
    await page.click('#db-refresh');
    await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 2);
    assert.match(await page.textContent('.banner__text'), /"2" Clients/);
    assert.match(await page.textContent('#db-meta'), /Records: 11/);
    net.rows = BASE_ROWS;
  });

  await step('Refresh failure with cache → keeps searching, shows Update Failed', async () => {
    net.mode = 'http500';
    await page.click('#db-refresh');
    await page.waitForFunction(() => document.getElementById('db-status').dataset.state === 'stale');
    assert.equal(await page.textContent('#db-label'), 'Update Failed — Using Cached Data');
    await searchZip(page, '63010');
    assert.equal(await bannerTitle(page), 'ZIP Verified');
    net.mode = 'ok';
  });

  await step('Offline with cache → "Offline — Using Cached Data", search still works', async () => {
    net.mode = 'fail';
    await ctx.setOffline(true);
    await page.click('#db-refresh');
    await page.waitForFunction(() => document.getElementById('db-status').dataset.state === 'offline');
    assert.equal(await page.textContent('#db-label'), 'Offline — Using Cached Data');
    await searchZip(page, '06082');
    assert.equal(await bannerTitle(page), 'ZIP Verified');
    await ctx.setOffline(false);
    net.mode = 'ok';
  });

  await step('Test 8 — five clocks in order, correct times', async () => {
    const labels = await page.$$eval('.clock__label', (n) => n.map((x) => x.textContent));
    assert.deepEqual(labels, ['Pakistan (PKT)', 'Pacific (PST/PDT)', 'Mountain (MST/MDT)', 'Central (CST/CDT)', 'Eastern (EST/EDT)']);
    const ok = await page.evaluate(() => [...document.querySelectorAll('.clock')].every((c) => {
      const expected = new Intl.DateTimeFormat('en-US', { timeZone: c.dataset.tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
      return c.querySelector('.clock__time').textContent.replace(/:\d\d /, ' ') === expected;
    }));
    assert.ok(ok, 'clock times match Intl for each zone');
    const t1 = await page.textContent('.clock__time');
    await page.waitForTimeout(1100);
    assert.notEqual(await page.textContent('.clock__time'), t1, 'clocks tick every second');
  });

  await step('Card icons + floating checklist notice (minimize / restore), footer removed', async () => {
    await searchZip(page, '63010');
    assert.equal(await page.$$eval('.result-card .field__icon svg use', (n) => n.length), 4, 'icons for ZIP, State, Timings, Preset');
    assert.equal(await page.$('footer'), null);
    assert.equal(await page.textContent('#notice-title'), 'Required Action Checklist');
    assert.match(await page.textContent('.notice__body'), /^\s*Disclaimer: Before transferring the call.*Project Sunroof.*before proceeding\.\s*$/s);
    const box = await page.$eval('#notice', (n) => { const r = n.getBoundingClientRect(); return { left: r.left, bottom: innerHeight - r.bottom }; });
    assert.ok(box.left < 40 && box.bottom < 40, 'anchored bottom-left');
    await page.click('#notice-collapse');
    assert.equal(await page.getAttribute('#notice', 'data-collapsed'), 'true');
    assert.ok(await page.isVisible('#notice-expand'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'notice-expand');
    await page.click('#notice-expand');
    assert.ok(await page.isVisible('.notice__body'));
    await page.focus('#zip-input');
  });

  await step('No console/page errors during the session', async () => {
    assert.deepEqual(pageErrors.map(String), []);
  });
  await ctx.close();

  /* ---------------- DST: abbreviations switch automatically ---------------- */
  await step('Test 8b — DST transitions handled by Intl (winter vs summer)', async () => {
    for (const [iso, expect] of [['2026-01-15T18:00:00Z', ['PKT', 'PST', 'MST', 'CST', 'EST']], ['2026-07-15T18:00:00Z', ['PKT', 'PDT', 'MDT', 'CDT', 'EDT']]]) {
      const c = await browser.newContext({ serviceWorkers: 'block' });
      await installRoutes(c);
      const p = await c.newPage();
      await p.clock.install({ time: new Date(iso) });
      await p.goto(BASE);
      await p.waitForFunction(() => document.querySelectorAll('.clock__abbr')[1].textContent !== '');
      const abbrs = await p.$$eval('.clock__abbr', (n) => n.map((x) => x.textContent));
      assert.deepEqual(abbrs, expect, iso);
      const times = await p.$$eval('.clock__time', (n) => n.map((x) => x.textContent));
      // 18:00Z → Karachi 23:00 all year; New York 13:00 (EST) or 14:00 (EDT)
      assert.equal(times[0], '11:00:00 PM');
      assert.equal(times[4], iso.includes('-01-') ? '01:00:00 PM' : '02:00:00 PM');
      await c.close();
    }
  });

  /* ---------------- First visit with no network and no cache ---------------- */
  await step('No cache + API down → "Unable to load ZIP database" with retry', async () => {
    net.mode = 'fail';
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    await p.goto(BASE);
    await p.waitForFunction(() => document.getElementById('db-status').dataset.state === 'error');
    assert.equal(await p.textContent('.banner__title'), 'Unable to load ZIP database.');
    assert.match(await p.textContent('.banner__text'), /check your internet connection and reload/);
    // Retry after network returns
    net.mode = 'ok';
    await p.click('.banner .btn');
    await waitReady(p);
    await searchZip(p, '63010');
    assert.equal(await bannerTitle(p), 'ZIP Verified');
    await c.close();
  });

  /* ---------------- Search typed before DB ready runs automatically ---------------- */
  await step('ZIP typed while DB initializing runs automatically once ready', async () => {
    net.delay = 1500;
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    await p.goto(BASE);
    await searchZip(p, '91115');
    assert.equal(await bannerTitle(p), 'Initializing ZIP Database…');
    await p.waitForFunction(() => document.querySelector('.banner__title')?.textContent === 'ZIP Verified', null, { timeout: 8000 });
    net.delay = 0;
    await c.close();
  });

  /* ---------------- Main-thread engine fallback (no Worker) ---------------- */
  await step('Engine fallback: works without Web Workers (inline engine)', async () => {
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    await p.addInitScript(() => { window.ZIP_CHECKER_CONFIG = { useWorker: false }; });
    await p.goto(BASE);
    await waitReady(p);
    assert.equal(await p.evaluate(() => typeof window.ZipEngine), 'object', 'inline engine loaded');
    await searchZip(p, '91115');
    assert.match(await p.textContent('.banner__text'), /"3" Clients/);
    await c.close();
  });

  /* ---------------- CSV fallback source ---------------- */
  await step('OpenSheet down → Google Sheets CSV fallback loads the same data', async () => {
    net.mode = 'fail'; net.gviz = 'ok';
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    await p.goto(BASE);
    await waitReady(p);
    await searchZip(p, '06082');
    assert.equal(await p.textContent('.f-zip'), '06082');
    await searchZip(p, '91115');
    assert.match(await p.textContent('.banner__text'), /"3" Clients/);
    net.mode = 'ok'; net.gviz = 'fail';
    await c.close();
  });

  /* ---------------- Performance at production scale ---------------- */
  await step('Performance: ~25k rows — indexed lookup + render timings', async () => {
    net.rows = bigDataset(25000);
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    const t0 = Date.now();
    await p.goto(BASE);
    await waitReady(p);
    const coldMs = Date.now() - t0;
    const perf = await p.evaluate(() => {
      const zc = window.__zipChecker;
      const zips = [];
      for (let i = 0; i < 10000; i++) zips.push(String(10000 + ((i * 7919) % 89999)));
      const a = performance.now();
      let hits = 0;
      for (const z of zips) if (zc.lookup(z).length) hits++;
      const lookupUs = ((performance.now() - a) / zips.length) * 1000;
      // Full UI path: set value → submit → DOM rendered
      const input = document.getElementById('zip-input');
      const form = document.getElementById('search-form');
      const b = performance.now();
      for (let i = 0; i < 200; i++) {
        input.value = i % 2 ? '91115' : '99999';
        form.requestSubmit();
      }
      const renderMs = (performance.now() - b) / 200;
      return { lookupUs, renderMs, hits };
    });
    const t1 = Date.now();
    await p.reload();
    await waitReady(p);
    const warmMs = Date.now() - t1;
    console.log(`      cold load (download+index): ${coldMs} ms · warm load (IndexedDB): ${warmMs} ms`);
    console.log(`      lookup: ${perf.lookupUs.toFixed(2)} µs/lookup · full search+render: ${perf.renderMs.toFixed(2)} ms/search`);
    assert.ok(perf.renderMs < 16, 'search+render under one frame');
    assert.ok(perf.lookupUs < 50);
    net.rows = BASE_ROWS;
    await c.close();
  });

  /* ---------------- Service worker + true offline reload (Test 6) ---------------- */
  await step('Test 6 — PWA: offline reload serves shell from SW, search uses IndexedDB', async () => {
    const c = await browser.newContext();
    await installRoutes(c);
    const p = await c.newPage();
    await p.goto(BASE);
    await waitReady(p);
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload(); // let SW take control and populate cache
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await waitReady(p);
    net.mode = 'fail';
    await c.setOffline(true);
    await p.reload();
    await waitReady(p);
    await searchZip(p, '91115');
    assert.match(await p.textContent('.banner__text'), /"3" Clients/);
    await p.waitForFunction(() => document.getElementById('db-status').dataset.state === 'offline');
    await c.setOffline(false);
    net.mode = 'ok';
    // New deployment is picked up on the very next reload (network-first shell).
    deploy.marker = 'v2';
    await p.reload();
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal(await p.getAttribute('body', 'data-deploy'), 'v2', 'fresh index.html served while online');
    deploy.marker = '';
    await c.close();
  });

  /* ---------------- Responsive layout ---------------- */
  await step('Responsive: clocks beside results on desktop, below on mobile', async () => {
    const c = await browser.newContext({ serviceWorkers: 'block' });
    await installRoutes(c);
    const p = await c.newPage();
    await p.setViewportSize({ width: 1366, height: 900 });
    await p.goto(BASE);
    let r = await p.evaluate(() => [document.querySelector('.col-main').getBoundingClientRect().toJSON(), document.querySelector('.col-side').getBoundingClientRect().toJSON()]);
    assert.ok(r[1].left > r[0].right - 1, 'side column to the right');
    await p.setViewportSize({ width: 390, height: 844 });
    r = await p.evaluate(() => [document.querySelector('.col-main').getBoundingClientRect().toJSON(), document.querySelector('.col-side').getBoundingClientRect().toJSON()]);
    assert.ok(r[1].top >= r[0].bottom - 1, 'clocks stacked below');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal scroll on mobile');
    await c.close();
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
