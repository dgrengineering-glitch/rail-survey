/* Rail Survey – shared helpers (no dependencies). */
'use strict';

const APP_VERSION = '0.1.0';
const APP_VERSION_LABEL = 'v' + APP_VERSION + ' beta';
const CHAINS_PER_MILE = 80;
const YARDS_PER_CHAIN = 22;
const METRES_PER_MILE = 1609.344;

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256 | 0; });
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- numbers & formatting ---------- */
function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function round(n, dp = 0) { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
function fmtCoord(n) { return n == null ? '–' : Number(n).toFixed(6); }
function fmtAcc(a) { return a == null ? '' : '±' + (a < 10 ? round(a, 1) : Math.round(a)) + ' m'; }
function accClass(a) { return a == null ? '' : a <= 5 ? 'good' : a <= 15 ? 'fair' : 'poor'; }

const pad2 = n => String(n).padStart(2, '0');
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDateTimeSecs(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  return fmtDateTime(iso) + ':' + pad2(d.getSeconds());
}
function fmtBytes(b) { return b < 1024 ? b + ' B' : b < 1048576 ? round(b / 1024, 0) + ' KB' : round(b / 1048576, 1) + ' MB'; }
function fileStamp(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`; }

/* ---------- mileage (miles & chains) ---------- */
function chainsToYards(ch) { const c = num(ch); return c == null ? null : round(c * YARDS_PER_CHAIN, 1); }
function yardsToChains(yd) { const y = num(yd); return y == null ? null : round(y / YARDS_PER_CHAIN, 2); }
function fmtChains(ch) { const c = num(ch); if (c == null) return ''; return Number.isInteger(c) ? pad2(c) : (c < 10 ? '0' : '') + String(round(c, 2)); }
function fmtMileage(miles, chains) {
  const m = num(miles), c = num(chains);
  if (m == null && c == null) return '';
  return `${m == null ? 0 : m}m ${fmtChains(c == null ? 0 : c)}ch`;
}
// Decimal miles → { miles, chains } (chains rounded to the nearest whole chain).
function milesToMC(decMiles) {
  let m = Math.floor(decMiles), c = Math.round((decMiles - m) * CHAINS_PER_MILE);
  if (c >= CHAINS_PER_MILE) { m += 1; c -= CHAINS_PER_MILE; }
  return { miles: m, chains: c };
}
function recordMileage(r) { return fmtMileage(r.miles, r.chains); }

/* ---------- tag auto-increment: "ATS 123" → "ATS 124", "ATS 009" → "ATS 010" ---------- */
function nextTag(last) {
  if (!last) return '';
  const m = String(last).match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return String(last) + ' 2';
  const n = String(Number(m[2]) + 1);
  return m[1] + (m[2].length > n.length ? n.padStart(m[2].length, '0') : n) + m[3];
}

/* ---------- coordinates from pasted text / Google Maps links ---------- */
function validLatLon(lat, lon) { return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0); }
function inGB(lat, lon) { return lat > 49.5 && lat < 61.2 && lon > -8.8 && lon < 2.2; }
function dmsToDec(d, m, s, hemi) {
  let v = Number(d) + (Number(m) || 0) / 60 + (Number(s) || 0) / 3600;
  if (/[SW]/i.test(hemi || '')) v = -v;
  return v;
}
/** Parse a Google Maps URL, "lat, lon" or DMS text. Returns {lat, lon, source} or {error}. */
function parseLocationText(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'Nothing to read – paste a Google Maps link or coordinates.' };
  let dec = s;
  try { dec = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
  const ok = (lat, lon, source) => validLatLon(lat, lon) ? { lat: round(lat, 7), lon: round(lon, 7), source } : null;
  let m, r;
  // Place pin inside Google Maps data blob: !3d<lat>!4d<lon> (most accurate for a dropped/placed pin)
  if ((m = dec.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)) && (r = ok(+m[1], +m[2], 'maps-link'))) return r;
  // Query parameters: q= / query= / ll= / sll= / center= / destination= / daddr=
  if ((m = dec.match(/[?&](?:q|query|ll|sll|center|destination|daddr|saddr)=\s*(?:loc:)?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i)) && (r = ok(+m[1], +m[2], 'maps-link'))) return r;
  // Map view centre: /@lat,lon,zoom
  if ((m = dec.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)) && (r = ok(+m[1], +m[2], 'maps-link'))) return r;
  if (/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(s)) {
    return { error: 'That’s a Google Maps short link, which can’t be read offline. In Google Maps, long-press the pin and copy the coordinates shown (two numbers such as 5x.xxxxx, -x.xxxxx), or open the link in Safari and copy the full address, then paste that here.' };
  }
  // DMS e.g. 51°30'26.5"N 0°07'39.0"W
  const dms = /(\d{1,3})\s*[°º]\s*(\d{1,2})?\s*['′’]?\s*(\d{1,2}(?:\.\d+)?)?\s*["″”]?\s*([NSEW])/gi;
  const parts = []; while ((m = dms.exec(dec))) parts.push(m);
  if (parts.length >= 2) {
    let lat = null, lon = null;
    for (const p of parts) { const v = dmsToDec(p[1], p[2], p[3], p[4]); if (/[NS]/i.test(p[4])) lat = v; else lon = v; }
    if (lat != null && lon != null && (r = ok(lat, lon, 'manual'))) return r;
  }
  // Plain decimal pair "lat, lon" (also "lat lon")
  if ((m = dec.match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/)) && (r = ok(+m[1], +m[2], /https?:/i.test(s) ? 'maps-link' : 'manual'))) return r;
  return { error: 'Couldn’t find coordinates in that. Paste a full Google Maps link or coordinates as two numbers: latitude, longitude.' };
}

function mapsUrl(lat, lon) { return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; }
function earthUrl(lat, lon) { return `https://earth.google.com/web/@${lat},${lon},0a,400d,35y,0h,0t,0r`; }

/* ---------- distance helpers ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });
}
function dataURLToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64 || ''); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}
function arrayBufferToBase64(buf) {
  const u8 = new Uint8Array(buf); let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function withTimeout(ms, parentSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  if (parentSignal) { if (parentSignal.aborted) ctrl.abort(); else parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  return { signal: ctrl.signal, done: () => clearTimeout(t), ctrl };
}
