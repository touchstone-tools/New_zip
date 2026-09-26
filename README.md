# ZIP Checker — ZIP Verification

A fast, keyboard-first ZIP verification tool for call-center agents.
It's a static PWA written in vanilla HTML/CSS/JS, with no framework and no build step.

**Data source (single source of truth):** Google Sheet
[`1CzToIFZSkV3-kB0vklv9cSU-naNpppM_c5hSz3rKkwU`](https://docs.google.com/spreadsheets/d/1CzToIFZSkV3-kB0vklv9cSU-naNpppM_c5hSz3rKkwU/edit?gid=0#gid=0), worksheet **`AllZips`**. Access is read-only, with no credentials.

## Why it's fast

| Old app | This app |
|---|---|
| Downloads the whole sheet on **every** search | Downloads the sheet **once** at startup, then only in the background |
| `data.filter(...)` over ~22k rows per search | `zipIndex.get(zip)`: an O(1) `Map` lookup |
| Waits for the network before first search | Opens from the **IndexedDB** cache instantly (stale-while-revalidate) |

Measured in headless Chromium with a 25k-row dataset:
**~0.6 µs per lookup**, **~0.1 ms** for the whole search-and-render path, and ~200 ms from page load to ready when using the cache.

```
Google Sheet ─► OpenSheet (primary) / Google gviz CSV (fallback)
                      │  (Web Worker: fetch → normalize → hash → index)
                      ▼
              Map<zip, records[]> ──► IndexedDB (persisted)
                 │                         │
                 ▼                         ▼
     Instant search on main thread   Next launch: cache first, refresh in background
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Semantic app shell, Material icon sprite, result-card `<template>`, checklist notice, CSP |
| `styles.css` | Glass-style responsive UI (no web fonts, no `backdrop-filter`, respects reduced motion) |
| `app.js` | UI controller: search hot path, rendering, status indicator, clocks, keyboard, config |
| `data-worker.js` | Data engine (Web Worker). Fetch, normalize, index, IndexedDB, change detection. Also runs on the main thread if Workers are unavailable |
| `sw.js` | Service worker. Caches the **app shell only**; the ZIP data is never cached here |
| `manifest.json`, `icons/` | PWA metadata and icons |
| `tests/` | Node unit tests + Playwright end-to-end acceptance tests |

## Deploy

Upload the repository root to any static host (GitHub Pages, Netlify, Cloudflare Pages, S3, nginx, IIS, and so on). No build or source changes are needed.
Use HTTPS, because service workers need it (`localhost` is exempt).

Local preview:

```bash
python3 -m http.server 8080      # or: npm start
# open http://localhost:8080
```

The service worker loads app files **network-first**: while the server is reachable, every load gets the latest deployed files, and the cached copy is used only when the network is down or takes longer than 3 s. When a new service worker takes over while the agent is idle, the page reloads itself once. Bumping `VERSION` in `sw.js` also clears out old cached files.

## Data behaviour

* **Startup:** the ZIP database starts loading right away. With a cache the app is ready in milliseconds, and the sheet is re-fetched in the background.
* **First visit:** shows "Initializing ZIP Database…". A ZIP typed during loading runs by itself once data arrives.
* **Change detection:** a hash of the normalized rows. The index is swapped atomically only when the sheet really changed. A result on screen is re-rendered with the new data.
* **Refresh triggers:** app start, every 10 minutes while visible, on tab focus if the last check is older than 5 minutes, when the connection comes back, and the ↻ button.
* **Safety:** a failed or empty response never overwrites a good cache.
* **Multiple tabs:** tabs share updates through `BroadcastChannel`.
* **ZIP normalization:** ZIPs are always 5-digit strings. The sheet stores many ZIPs as numbers (for example `6082` for CT), so sheet values are left-padded to `06082`. `ZIP+4` values keep the first five digits. Agent input is **never** padded, so `123` is an invalid ZIP.
* **Displayed fields:** `Zip`/`ZipState`, `State`, `Good to Go on Client`, `Timings`, `Transfer to Preset`. A missing value shows **N/A**, and other columns are ignored. Rows that are identical in every column are shown once.
* **Security:** all sheet values are inserted with `textContent` (never `innerHTML`). A strict CSP only allows connections to the sheet endpoints.

### Status indicator

`Initializing ZIP Database…` → `ZIP Database Ready` / `Updating Data…` / `Offline — Using Cached Data` / `Update Failed — Using Cached Data` / `Unable to load ZIP database`, plus **Updated:** time and **Records:** count.

## Result cards & checklist notice

* Each result card shows the client name with a **Material icon** for every field: ZIP Code (`pin_drop`), State (`map`), Timings (`schedule`) and Transfer to Preset (`phone_forwarded`). The Transfer to Preset field is highlighted.
* The icons are the official Material Design SVG paths (Apache 2.0), included as an inline sprite in `index.html`. There's no icon-font download, and they work offline.
* A floating **Required Action Checklist** (`assignment_late`) sits at the bottom right with the CRM / address-verification disclaimer.
  * The minimize button shrinks it to a small "Checklist" button, and clicking that brings it back.
  * It starts minimized on phones.
  * It gives a short nudge each time a ZIP is verified.
  * The page adds bottom padding so the notice never permanently hides content.

## Keyboard

| Key | Action |
|---|---|
| typing 5 digits | searches right away (Enter also works) |
| `Enter` | search |
| `Esc` | clear and refocus |
| any digit, anywhere | jumps into the ZIP box |

The ZIP input is focused on load and stays focused after each search. Its text is selected, so the next ZIP simply overwrites it. Browser shortcuts (Ctrl/Cmd+F5, and so on) are never intercepted.

## Configuration

Defaults live at the top of `app.js` (`DEFAULTS`). To override them without editing, add a same-origin script before `app.js` that sets `window.ZIP_CHECKER_CONFIG`:

```js
window.ZIP_CHECKER_CONFIG = {
  refreshIntervalMs: 5 * 60 * 1000,   // background re-check while open (0 = off)
  refreshOnFocusAfterMs: 5 * 60 * 1000,
  fetchTimeoutMs: 30000,
  autoSearchOnFiveDigits: true,       // set false to require Enter
  useWorker: true,
  serviceWorker: true
  // sheetId / sheetName / sources can also be overridden
};
```

**Data sources, in order:**

1. `https://opensheet.elk.sh/<id>/AllZips`. This is the same endpoint the original app used. It returns the exact formatted cell text.
2. `https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&headers=1&sheet=AllZips`. This is only a fallback: Google's gviz endpoint guesses column types and can drop values in mixed-type columns.

## Timezone clocks

Pakistan (PKT), then Pacific, Mountain, Central and Eastern. They are built on `Intl.DateTimeFormat` with IANA zones, so DST changes happen automatically; the badge switches between PST and PDT, and so on. They update every second, aligned to the wall clock.

## Tests

```bash
npm install
npx playwright install chromium
npm test            # unit + end-to-end
```

The end-to-end suite intercepts the sheet endpoints with fixtures modelled on the real data. It covers all 8 acceptance tests from the spec, plus DST, XSS escaping, missing fields, the CSV fallback, the no-Worker fallback, change detection, error states, service-worker offline reloads, responsive layout, and a 25k-row performance check. To use an existing Chromium, set `CHROME_PATH=/path/to/chrome`.
