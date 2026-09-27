# Rail Survey (beta)

A mobile-first, offline-capable web app for marking and recording track-side survey locations: GPS position, tag, notes (with dictation), distance from running edge, ELR / track ID / miles / chains / yards, extra measurements and photos. Exports to KML, KMZ (with photos), Excel and CSV, with full JSON backup and restore. Optional sync to your own Google Sheet.

**Live app:** https://dgrengineering-glitch.github.io/rail-survey/

On iPhone, open it in Safari, then **Share › Add to Home Screen**. Open it from the icon, and after that it works with no signal.

## Privacy

- All survey data is stored **only on the device**, in IndexedDB. This repository contains code only: no survey data, no keys, no coordinates.
- Data leaves the device only if you (a) switch on Google Sheet sync (your own Apps Script, see [SETUP.md](SETUP.md)), or (b) tap **Estimate from mileposts**, which sends your approximate position to the public OpenStreetMap Overpass API.

## Features

- Big **Mark Location** button. It starts high-accuracy GPS straight away (`watchPosition`, ~10 s, keeps the best fix) and shows lat/long and ±accuracy live. You can **Accept**, **Refine** or enter the location **manually** (lat/long, a pasted Google Maps link or DMS coordinates). If a photo has EXIF GPS and there's no fix, the app offers to use it.
- Tag auto-increment (ATS 123 → ATS 124). ELR, track ID and measurement names carry over from the last record.
- Notes with **Dictate**, using the Web Speech API (en-GB, appends to existing text, Stop/Cancel, fallback timers so it can't freeze). If that isn't available, a hint points to the iPhone keyboard mic.
- Mileage entry: yards are calculated from chains (1 ch = 22 yd), shown as `ELR 12m 34ch (748 yd)`.
- Optional **Estimate from mileposts**: an OpenStreetMap Overpass lookup that suggests an ELR (from the line's `ref`), track names (`railway:track_ref`) and an interpolated mileage between the nearest two `railway=milestone` nodes. It's labelled *approximate – verify against NR records*, and nothing is filled in until you tap it.
- Photos: camera or library. They're compressed to about 1600 px JPEG, with a thumbnail, and stored in IndexedDB.
- Summary list (newest first) with search, a details view, edit, delete (with confirmation), and Google Maps / Google Earth links.
- Exports are generated on the device and shared through the Web Share API, or downloaded: **KML**, **KMZ** (`doc.kml` + `files/*.jpg`, referenced in each placemark's description), **Excel .xlsx** (Summary + Measurements sheets, written by hand with JSZip), **CSV**, and a **JSON backup** (including photos) with restore.
- Optional **Google Sheet sync** through an Apps Script web app ([apps-script/Code.gs](apps-script/Code.gs)): a shared-secret token, upsert by record UUID, photos saved to Drive with links written into the sheet, a sync queue with badges, automatic retry and deletes.
- An installable PWA (manifest, icons, apple-touch-icon) with a versioned, cache-busting service worker. It works fully offline once loaded.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `styles.css` | UI (high-contrast, one-handed, bottom tab bar) |
| `js/util.js` | helpers, version, mileage maths, Google Maps link parsing |
| `js/db.js` | IndexedDB (records, photos, delete queue) and settings |
| `js/geo.js` | GPS capture, EXIF GPS reader, photo compression |
| `js/voice.js` | dictation controller |
| `js/chainage.js` | Overpass milepost / ELR helper |
| `js/export.js` | KML / KMZ / XLSX / CSV / JSON backup and restore, share and download |
| `js/sync.js` | Google Sheet sync queue |
| `js/app.js` | UI controller |
| `sw.js`, `manifest.json`, `icons/` | PWA |
| `vendor/jszip.min.js` | JSZip 3.10.1 (MIT), vendored for offline use |
| `apps-script/Code.gs` | Google Apps Script web app for optional sync |

## Releasing a new version

Bump the version in **all three** places, so phones pick up the update and the caches are busted:

1. `APP_VERSION` in `js/util.js`
2. `VERSION` and `Q` in `sw.js`
3. The `?v=` query strings in `index.html`

When the new service worker takes over, the app shows a *new version is ready – Reload* banner.
