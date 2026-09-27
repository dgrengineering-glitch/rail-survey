/* Rail Survey – optional sync to David's own Google Sheet via a Google Apps Script web app.
   Data stays on the phone unless sync is switched on in Settings.
   Requests are text/plain POSTs (a CORS "simple request", so no preflight – the usual Apps Script pattern). */
'use strict';

let SYNC_TIMEOUT_MS = 45000;
const SYNC_RETRY_MIN_MS = 15000, SYNC_RETRY_MAX_MS = 10 * 60000;

class SyncError extends Error { constructor(msg, kind) { super(msg); this.kind = kind || 'error'; } }

function isDirty(r) { return (r.rev || 0) !== (r.syncedRev || 0); }

const Sync = {
  running: false, again: false, retryTimer: null, backoff: 0, listeners: [], lastResult: '',
  configured() { const s = Settings.load(); return !!(s.syncEnabled && s.scriptUrl && s.token); },
  onChange(fn) { this.listeners.push(fn); },
  notify() { this.listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); },
  async pending() {
    const recs = (await DB.all('records')).filter(isDirty);
    const tombs = await DB.all('tombstones');
    return { records: recs.length, deletes: tombs.length, total: recs.length + tombs.length };
  },
  async post(payload, timeoutMs = SYNC_TIMEOUT_MS) {
    const s = Settings.load();
    const url = String(s.scriptUrl || '').trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) throw new SyncError('The Apps Script URL should start with https://script.google.com/macros/s/…', 'config');
    const t = withTimeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ token: s.token, client: 'rail-survey/' + APP_VERSION }, payload)), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', credentials: 'omit', signal: t.signal });
    } catch (e) {
      throw new SyncError(t.signal.aborted ? 'The Google Sheet didn’t reply in time.' : 'Couldn’t reach Google – check signal, or that the web app URL is right and deployed with access “Anyone”.', 'network');
    } finally { t.done(); }
    const text = await res.text().catch(() => '');
    let j = null; try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!j) {
      if (/<html|<!doctype/i.test(text)) throw new SyncError('Google returned a web page instead of data – redeploy the web app with “Who has access: Anyone” and use the /exec URL.', 'config');
      throw new SyncError('Unexpected reply from the Google Sheet (HTTP ' + res.status + ').', 'server');
    }
    if (!j.ok) throw new SyncError(j.error || 'The Google Sheet reported an error.', j.code === 'bad_token' ? 'auth' : 'server');
    return j;
  },
  test() { return this.post({ action: 'ping' }, 20000); },
  recordPayload(r, photoLinks) {
    return {
      id: r.id, tag: r.tag || '', notes: r.notes || '', lat: r.lat, lon: r.lon, accuracy: r.accuracy != null ? round(r.accuracy, 1) : '',
      runningEdgeMm: r.runningEdgeMm != null ? r.runningEdgeMm : '', measurements: measurementsText(r),
      elr: r.elr || '', trackId: r.trackId || '', miles: r.miles != null ? r.miles : '', chains: r.chains != null ? r.chains : '', yards: r.yards != null ? r.yards : '',
      mileage: recordMileage(r), timestamp: r.createdAt, timestampLocal: fmtDateTimeSecs(r.createdAt), updatedAt: r.updatedAt, surveyor: r.surveyor || '',
      locSource: r.locSource || '', mapsUrl: hasLoc(r) ? mapsUrl(r.lat, r.lon) : '', photoLinks: photoLinks || []
    };
  },
  schedule(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.run('retry'), ms);
  },
  async run(reason) {
    if (!this.configured()) return { skipped: 'not configured' };
    if (!navigator.onLine) return { skipped: 'offline' };
    if (this.running) { this.again = true; return { skipped: 'busy' }; }
    this.running = true; this.again = false; this.notify();
    let done = 0, failed = null;
    try {
      // 1. deletions
      for (const tb of await DB.all('tombstones')) {
        await this.post({ action: 'delete', id: tb.id });
        await DB.del('tombstones', tb.id); done++;
      }
      // 2. new / edited records, oldest first
      const dirty = (await DB.all('records')).filter(isDirty).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      for (const r0 of dirty) {
        const rev = r0.rev || 0;
        const photos = await DB.photosFor(r0.id);
        const links = [];
        for (const p of photos) {
          if (!p.driveUrl) {
            const j = await this.post({ action: 'photo', recordId: r0.id, photoId: p.id, tag: r0.tag || '', filename: `${safeName(r0.tag || 'location')}_${p.id.slice(0, 8)}.jpg`, mime: p.type || 'image/jpeg', data: arrayBufferToBase64(p.data) }, 90000);
            p.driveUrl = j.url || '';
            await DB.put('photos', p);
          }
          if (p.driveUrl) links.push(p.driveUrl);
        }
        await this.post({ action: 'upsert', record: this.recordPayload(r0, links) });
        const cur = await DB.get('records', r0.id);
        if (cur) { cur.syncedRev = rev; cur.syncedAt = new Date().toISOString(); cur.syncError = ''; await DB.put('records', cur); }
        done++;
        this.notify();
      }
      this.backoff = 0;
      Settings.set({ lastSyncAt: new Date().toISOString(), lastSyncError: '' });
    } catch (e) {
      failed = e;
      this.backoff = Math.min(SYNC_RETRY_MAX_MS, Math.max(SYNC_RETRY_MIN_MS, this.backoff * 2));
      Settings.set({ lastSyncError: e.message || String(e) });
      if (e.kind !== 'config' && e.kind !== 'auth') this.schedule(this.backoff);
    } finally {
      this.running = false; this.notify();
    }
    if (this.again && !failed) { this.again = false; return this.run('again'); }
    if (failed) throw failed;
    return { done };
  },
  /** Fire-and-forget wrapper used by automatic triggers. */
  kick(reason) { this.run(reason).catch(e => console.info('Sync deferred:', e.message)); }
};
