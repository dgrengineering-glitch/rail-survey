/* Rail Survey – GPS capture, EXIF GPS reading and photo compression. */
'use strict';

/**
 * GPS capture using watchPosition, keeping the most accurate fix.
 * onUpdate(state) is called with { status, best, count, remainingMs, error }.
 * status: idle | acquiring | done | denied | unavailable | error
 */
class GpsCapture {
  constructor(onUpdate) { this.onUpdate = onUpdate || (() => {}); this.best = null; this.count = 0; this.status = 'idle'; this.watchId = null; this.timer = null; this.deadline = 0; this.error = ''; this.run = 0; }
  get remainingMs() { return Math.max(0, this.deadline - Date.now()); }
  get supported() { return !!(navigator.geolocation && window.isSecureContext !== false); }
  start(seconds = 10, keepBest = true) {
    this.stop(false);
    if (!keepBest) { this.best = null; this.count = 0; }
    this.error = '';
    if (!this.supported) { this.status = 'unavailable'; this.error = 'Location isn’t available in this browser.'; this.emit(); return; }
    const run = ++this.run;
    this.status = 'acquiring';
    const started = Date.now();
    this.deadline = started + seconds * 1000;
    this.durationMs = seconds * 1000;
    const hardStop = started + Math.max(seconds * 1000, 45000); // keep waiting up to 45 s for a first fix
    try {
      this.watchId = navigator.geolocation.watchPosition(
        pos => {
          if (run !== this.run) return;
          const c = pos.coords;
          if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
          this.count++;
          const fix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy, at: new Date(pos.timestamp || Date.now()).toISOString() };
          if (!this.best || !(this.best.accuracy <= fix.accuracy)) this.best = fix;
          this.emit();
          if (this.best.accuracy <= 3 && this.count >= 2) this.finish(run);
        },
        err => {
          if (run !== this.run) return;
          if (err && err.code === 1) { this.status = 'denied'; this.error = permissionHelp(); this.stop(false); this.emit(); return; }
          // Timeout / unavailable: keep watching until the deadline; report softly.
          this.error = err && err.code === 3 ? 'Still waiting for GPS…' : 'GPS signal unavailable – move into the open or enter the location manually.';
          this.emit();
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    } catch (e) { this.status = 'error'; this.error = 'Couldn’t start GPS.'; this.emit(); return; }
    this.timer = setInterval(() => {
      if (run !== this.run) return;
      const now = Date.now();
      if (now >= this.deadline && this.best) { this.finish(run); return; }
      if (now >= hardStop && !this.best) { this.status = 'error'; this.error = 'No GPS fix after 45 seconds. Try again in the open, or enter the location manually.'; this.stop(false); this.emit(); return; }
      this.emit();
    }, 500);
    this.emit();
  }
  finish(run) { if (run !== this.run) return; this.stop(false); this.status = 'done'; this.emit(); }
  stop(emit = true) {
    if (this.watchId != null) { try { navigator.geolocation.clearWatch(this.watchId); } catch (e) { /* ignore */ } this.watchId = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.status === 'acquiring') this.status = this.best ? 'done' : 'idle';
    if (emit) this.emit();
  }
  cancel() { this.run++; this.stop(false); this.status = 'idle'; }
  emit() { try { this.onUpdate({ status: this.status, best: this.best, count: this.count, remainingMs: Math.max(0, this.deadline - Date.now()), error: this.error }); } catch (e) { console.error(e); } }
}

function permissionHelp() {
  return isStandalone()
    ? 'Location access is blocked for Rail Survey. On iPhone go to Settings › Privacy & Security › Location Services › Safari Websites and choose “While Using the App” (and switch on Precise Location), then close and reopen the app. Meanwhile, enter the location manually below.'
    : 'Location access was blocked. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › “While Using the App”, and tap “aA” › Website Settings › Location › Allow. Meanwhile, enter the location manually below.';
}

/* ---------- EXIF GPS (JPEG APP1) ---------- */
async function readExifGps(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    return parseExifGps(new DataView(buf));
  } catch (e) { return null; }
}
function parseExifGps(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off + 4 <= dv.byteLength) {
    const marker = dv.getUint16(off); const size = dv.getUint16(off + 2);
    if ((marker & 0xFF00) !== 0xFF00) return null;
    if (marker === 0xFFE1 && off + 10 <= dv.byteLength && dv.getUint32(off + 4) === 0x45786966) return parseTiffGps(dv, off + 10);
    if (marker === 0xFFDA) return null;
    off += 2 + size;
  }
  return null;
}
function parseTiffGps(dv, t) {
  const le = dv.getUint16(t) === 0x4949;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  if (u16(t + 2) !== 42) return null;
  const ifd0 = t + u32(t + 4);
  let gpsPtr = null, dateTime = null;
  const readIfd = (start, fn) => { const n = u16(start); for (let i = 0; i < n; i++) { const e = start + 2 + i * 12; if (e + 12 > dv.byteLength) break; fn(u16(e), u16(e + 2), u32(e + 4), e + 8); } };
  const ascii = (count, valOff) => { const o = count > 4 ? t + u32(valOff) : valOff; let s = ''; for (let i = 0; i < count - 1 && o + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
  readIfd(ifd0, (tag, type, count, valOff) => { if (tag === 0x8825) gpsPtr = u32(valOff); if (tag === 0x0132) dateTime = ascii(count, valOff); });
  if (gpsPtr == null) return null;
  const g = {};
  const rationals = (count, valOff) => { const o = t + u32(valOff); const out = []; for (let i = 0; i < count; i++) { const d = u32(o + i * 8 + 4); out.push(d ? u32(o + i * 8) / d : 0); } return out; };
  readIfd(t + gpsPtr, (tag, type, count, valOff) => {
    if (tag === 1) g.latRef = String.fromCharCode(dv.getUint8(valOff));
    else if (tag === 2 && type === 5) g.lat = rationals(count, valOff);
    else if (tag === 3) g.lonRef = String.fromCharCode(dv.getUint8(valOff));
    else if (tag === 4 && type === 5) g.lon = rationals(count, valOff);
    else if (tag === 31 && type === 5) g.hpe = rationals(1, valOff)[0];
  });
  if (!g.lat || !g.lon) return null;
  let lat = g.lat[0] + (g.lat[1] || 0) / 60 + (g.lat[2] || 0) / 3600;
  let lon = g.lon[0] + (g.lon[1] || 0) / 60 + (g.lon[2] || 0) / 3600;
  if (g.latRef === 'S') lat = -lat; if (g.lonRef === 'W') lon = -lon;
  if (!validLatLon(lat, lon)) return null;
  return { lat: round(lat, 7), lon: round(lon, 7), accuracy: g.hpe || null, dateTime };
}

/* ---------- photo compression (≈1600 px JPEG + 320 px thumbnail) ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => resolve({ img, url }); img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Couldn’t read that image.')); };
    img.src = url;
  });
}
function canvasBlob(canvas, q) {
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image compression failed.')), 'image/jpeg', q));
}
async function drawScaled(img, max, q) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  const blob = await canvasBlob(c, q);
  c.width = c.height = 0; // free memory on iOS
  return { blob, w, h };
}
async function compressPhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const full = await drawScaled(img, 1600, 0.82);
    const thumb = await drawScaled(img, 320, 0.7);
    return { id: uuid(), type: 'image/jpeg', data: await full.blob.arrayBuffer(), thumb: await thumb.blob.arrayBuffer(), w: full.w, h: full.h, size: full.blob.size, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', createdAt: new Date().toISOString() };
  } finally { URL.revokeObjectURL(url); }
}
