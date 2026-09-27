/* Rail Survey – IndexedDB storage. Photos are stored as ArrayBuffers (more robust than Blobs on iOS WebKit). */
'use strict';

const DB_NAME = 'rail-survey';
const DB_VERSION = 1;
let _dbp = null;

function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB is not available in this browser.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('recordId', 'recordId');
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } _dbp = null; };
      resolve(db);
    };
    req.onerror = () => { _dbp = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return _dbp;
}

function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Transaction aborted')); }); }

const DB = {
  async all(store) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).getAll()); },
  async get(store, id) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).get(id)); },
  async put(store, val) { const db = await openDB(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val); await txDone(tx); return val; },
  async del(store, id) { const db = await openDB(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); await txDone(tx); },
  async clearAll() {
    const db = await openDB(); const tx = db.transaction(['records', 'photos', 'tombstones'], 'readwrite');
    ['records', 'photos', 'tombstones'].forEach(s => tx.objectStore(s).clear()); await txDone(tx);
  },
  async photosFor(recordId) {
    const db = await openDB();
    const list = await reqP(db.transaction('photos').objectStore('photos').index('recordId').getAll(recordId));
    return list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  },
  /** Save a record together with its photo set (adds new photos, removes dropped ones) in one transaction. */
  async saveRecord(rec, photos) {
    const db = await openDB();
    const existing = await reqP(db.transaction('photos').objectStore('photos').index('recordId').getAllKeys(rec.id));
    const keep = new Set(photos.map(p => p.id));
    const tx = db.transaction(['records', 'photos'], 'readwrite');
    const ps = tx.objectStore('photos');
    existing.forEach(k => { if (!keep.has(k)) ps.delete(k); });
    photos.forEach(p => { if (p.data) ps.put(Object.assign({}, p, { recordId: rec.id })); });
    rec.photoIds = photos.map(p => p.id);
    tx.objectStore('records').put(rec);
    await txDone(tx);
    return rec;
  },
  async deleteRecord(id, tombstone) {
    const db = await openDB();
    const keys = await reqP(db.transaction('photos').objectStore('photos').index('recordId').getAllKeys(id));
    const tx = db.transaction(['records', 'photos', 'tombstones'], 'readwrite');
    keys.forEach(k => tx.objectStore('photos').delete(k));
    tx.objectStore('records').delete(id);
    if (tombstone) tx.objectStore('tombstones').put({ id, deletedAt: new Date().toISOString(), attempts: 0 });
    await txDone(tx);
  }
};

function photoBlob(p) { return p && p.data ? new Blob([p.data], { type: p.type || 'image/jpeg' }) : null; }
function thumbBlob(p) { return p && (p.thumb || p.data) ? new Blob([p.thumb || p.data], { type: 'image/jpeg' }) : null; }

/* Small settings store in localStorage */
const SETTINGS_KEY = 'rail-survey-settings';
const Settings = {
  _c: null,
  load() {
    if (this._c) return this._c;
    let s = {}; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    this._c = Object.assign({ surveyor: '', syncEnabled: false, scriptUrl: '', token: '', lastTag: '', lastElr: '', lastTrackId: '', lastSyncAt: '', lastSyncError: '', installDismissed: false, gpsSeconds: 10 }, s);
    return this._c;
  },
  get(k) { return this.load()[k]; },
  set(patch) { Object.assign(this.load(), patch); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._c)); } catch (e) { console.warn('Settings not saved', e); } },
  reset() { this._c = null; try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ } }
};
