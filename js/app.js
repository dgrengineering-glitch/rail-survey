/* Rail Survey – UI controller. */
'use strict';

const VIEW_TITLES = { home: 'Rail Survey', form: 'Mark Location', summary: 'Summary', detail: 'Location', settings: 'Settings', help: 'Help' };
const DEFAULT_MEAS_NAMES = ['Cant (mm)', 'Gauge (mm)', 'Six-foot (mm)', 'Cess width (mm)', 'Height above rail (mm)', 'Distance to signal (m)', 'Sleeper no.', 'Cable route offset (mm)'];
const S = { view: 'home', prev: 'home', records: [], form: null, detailId: null, listUrls: [], formUrls: [], detailUrls: [], saving: false, exporting: false, chainCtrl: null, swHadController: false };
let gps, dict;

/* ---------------- navigation ---------------- */
function showView(name, opts = {}) {
  if (S.view === 'form' && name !== 'form') teardownForm();
  if (S.view !== name && !opts.noPrev) S.prev = S.view;
  S.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name || (name === 'detail' && t.dataset.view === 'summary')));
  document.body.classList.toggle('form-open', name === 'form');
  $('#viewTitle').textContent = name === 'form' ? (S.form && !S.form.isNew ? 'Edit location' : 'Mark Location') : VIEW_TITLES[name];
  $('#backBtn').hidden = name !== 'detail';
  if (name === 'summary') renderList();
  if (name === 'settings') renderSettings();
  if (name === 'home') renderHome();
  window.scrollTo(0, 0);
}

async function refresh() {
  S.records = await DB.all('records');
  renderHome();
  if (S.view === 'summary') renderList();
  updateSyncUI();
}
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
function lastRecord() { return S.records.slice().sort(byNewest)[0] || null; }

/* ---------------- home ---------------- */
function renderHome() {
  const recs = S.records;
  $('#statCount').textContent = recs.length;
  const today = new Date().toDateString();
  $('#statToday').textContent = recs.filter(r => new Date(r.createdAt).toDateString() === today).length;
  const last = lastRecord();
  const lc = $('#lastCard');
  if (last) {
    lc.hidden = false; lc.dataset.id = last.id;
    lc.innerHTML = `<span class="muted small">Last location</span><b>${esc(last.tag || 'Untitled')}</b><span class="small">${esc(fmtDateTime(last.createdAt))}${recordMileage(last) ? ' · ' + esc((last.elr ? last.elr + ' ' : '') + recordMileage(last)) : ''}</span>`;
  } else lc.hidden = true;
  $('#installHint').hidden = !(isIOS() && !isStandalone() && !Settings.get('installDismissed'));
}

/* ---------------- form ---------------- */
function formEls() { return { tag: $('#fTag'), notes: $('#fNotes'), re: $('#fRunEdge'), elr: $('#fElr'), track: $('#fTrack'), miles: $('#fMiles'), chains: $('#fChains'), yards: $('#fYards'), surveyor: $('#fSurveyor') }; }

async function openForm(rec) {
  const e = formEls();
  const last = lastRecord();
  S.formUrls.forEach(u => URL.revokeObjectURL(u)); S.formUrls = [];
  if (rec) {
    const photos = await DB.photosFor(rec.id);
    S.form = { isNew: false, rec, id: rec.id, createdAt: rec.createdAt, loc: Number.isFinite(rec.lat) ? { lat: rec.lat, lon: rec.lon, accuracy: rec.accuracy, source: rec.locSource || 'gps' } : null, locAccepted: Number.isFinite(rec.lat), photos, measurements: (rec.measurements || []).map(m => ({ ...m })), dirty: false };
    e.tag.value = rec.tag || ''; e.notes.value = rec.notes || ''; e.re.value = rec.runningEdgeMm ?? '';
    e.elr.value = rec.elr || ''; e.track.value = rec.trackId || ''; e.miles.value = rec.miles ?? ''; e.chains.value = rec.chains ?? ''; e.yards.value = rec.yards ?? '';
    e.surveyor.value = rec.surveyor || '';
    $('#tagHint').hidden = true;
  } else {
    const lastTag = (last && last.tag) || Settings.get('lastTag') || '';
    S.form = { isNew: true, rec: null, id: uuid(), createdAt: new Date().toISOString(), loc: null, locAccepted: false, photos: [], measurements: last ? (last.measurements || []).filter(m => m.name).map(m => ({ name: m.name, value: '' })) : [], dirty: false };
    e.tag.value = nextTag(lastTag); e.notes.value = ''; e.re.value = '';
    e.elr.value = (last && last.elr) || Settings.get('lastElr') || ''; e.track.value = (last && last.trackId) || Settings.get('lastTrackId') || '';
    e.miles.value = ''; e.chains.value = ''; e.yards.value = '';
    e.surveyor.value = Settings.get('surveyor') || '';
    const th = $('#tagHint');
    if (lastTag) { th.hidden = false; th.innerHTML = `<span class="muted small">Last: ${esc(lastTag)}</span> <button type="button" class="chip" data-tag="${esc(lastTag)}">Same as last</button> <button type="button" class="chip" data-tag="${esc(nextTag(lastTag))}">${esc(nextTag(lastTag))}</button>`; }
    else th.hidden = true;
  }
  $('#fTime').textContent = fmtDateTimeSecs(S.form.createdAt);
  $('#manualPanel').hidden = true; $('#manPaste').value = ''; $('#manPasteResult').hidden = true;
  $('#manLat').value = S.form.loc ? S.form.loc.lat : ''; $('#manLon').value = S.form.loc ? S.form.loc.lon : '';
  $('#exifOffer').hidden = true; $('#chainResult').hidden = true; $('#chainResult').innerHTML = '';
  dict.reset(); $('#dictHint').hidden = dict.supported;
  updateMileage(); renderMeasurements(); renderPhotos();
  showView('form');
  if (S.form.isNew) gps.start(Number(Settings.get('gpsSeconds')) || 10, false);
  else { gps.cancel(); }
  renderGps();
}
function teardownForm() {
  gps.cancel(); dict.reset();
  if (S.chainCtrl) { S.chainCtrl.abort(); S.chainCtrl = null; }
  S.formUrls.forEach(u => URL.revokeObjectURL(u)); S.formUrls = [];
  S.form = null;
}
function markDirty() { if (S.form) S.form.dirty = true; }

/* ----- GPS panel ----- */
function pendingFix() { const f = S.form; return f && !f.locAccepted && gps.best && (gps.status === 'acquiring' || gps.status === 'done') ? Object.assign({}, gps.best, { source: 'gps' }) : null; }
function currentLoc() { const f = S.form; if (!f) return null; return pendingFix() || (f.loc && f.locAccepted ? f.loc : null); }
const SOURCE_LABEL = { gps: 'GPS', manual: 'manual entry', 'maps-link': 'Google Maps link', exif: 'photo GPS' };
function renderGps() {
  const f = S.form; if (!f) return;
  const capturing = gps.status === 'acquiring';
  const pend = pendingFix();
  const loc = pend || (f.locAccepted ? f.loc : null);
  let status = 'No location yet', cls = 'idle';
  if (capturing) { status = gps.best ? `Refining GPS… ${Math.ceil(gps.remainingMs / 1000)} s` : 'Getting GPS fix…'; cls = 'busy'; }
  else if (pend) { status = 'Best GPS fix – accept or refine'; cls = 'pending'; }
  else if (f.locAccepted && f.loc) { status = `✓ Location set (${SOURCE_LABEL[f.loc.source] || f.loc.source})`; cls = 'ok'; }
  else if (gps.status === 'denied') { status = 'Location permission denied'; cls = 'bad'; }
  else if (gps.status === 'error' || gps.status === 'unavailable') { status = 'No GPS fix'; cls = 'bad'; }
  const st = $('#gpsStatus'); st.textContent = status; st.className = 'gps-status st-' + cls;
  $('#gpsCount').textContent = capturing || pend ? `${gps.count} fix${gps.count === 1 ? '' : 'es'}` : '';
  $('#gpsLat').textContent = loc ? fmtCoord(loc.lat) : '–';
  $('#gpsLon').textContent = loc ? fmtCoord(loc.lon) : '–';
  const acc = $('#gpsAcc'); acc.textContent = loc && loc.accuracy != null ? fmtAcc(loc.accuracy) : (loc ? 'n/a' : '–'); acc.className = 'acc ' + (loc ? accClass(loc.accuracy) : '');
  const total = Math.max(1, gps.durationMs || 10000);
  $('#gpsBar').style.width = capturing ? Math.min(100, Math.round((1 - gps.remainingMs / total) * 100)) + '%' : (loc ? '100%' : '0%');
  $('#gpsBar').parentElement.classList.toggle('active', capturing);
  const msg = $('#gpsMsg');
  const showErr = gps.error && (gps.status === 'denied' || gps.status === 'error' || gps.status === 'unavailable' || (capturing && !gps.best));
  msg.hidden = !showErr; msg.textContent = showErr ? gps.error : '';
  msg.classList.toggle('bad', gps.status === 'denied' || gps.status === 'error' || gps.status === 'unavailable');
  $('#gpsAccept').hidden = !pend;
  const refine = $('#gpsRefine');
  refine.disabled = capturing && !gps.best;
  refine.textContent = capturing ? (gps.best ? '■ Stop' : 'Waiting…') : f.locAccepted && f.loc ? '↻ Re-capture' : gps.best ? '↻ Refine' : '↻ Retry GPS';
  if ((gps.status === 'denied' || gps.status === 'unavailable' || gps.status === 'error') && !f.locAccepted) $('#manualPanel').hidden = false;
}
function acceptFix() {
  const p = pendingFix(); if (!p) return;
  gps.stop(false);
  S.form.loc = { lat: round(p.lat, 7), lon: round(p.lon, 7), accuracy: round(p.accuracy, 1), source: 'gps', at: p.at };
  S.form.locAccepted = true; markDirty();
  $('#manLat').value = S.form.loc.lat; $('#manLon').value = S.form.loc.lon;
  renderGps(); toast('Location accepted ' + fmtAcc(S.form.loc.accuracy));
}
function refineFix() {
  const f = S.form;
  if (gps.status === 'acquiring') { gps.stop(); renderGps(); return; }
  const recapture = f.locAccepted && f.loc;
  f.locAccepted = false;
  gps.start(recapture ? (Number(Settings.get('gpsSeconds')) || 10) : 15, !recapture);
  renderGps();
}
function applyManual() {
  const lat = num($('#manLat').value), lon = num($('#manLon').value);
  if (!validLatLon(lat, lon)) { toast('Enter a valid latitude (−90 to 90) and longitude (−180 to 180)'); return; }
  gps.cancel();
  S.form.loc = { lat: round(lat, 7), lon: round(lon, 7), accuracy: null, source: S.form.manualSource || 'manual' };
  S.form.locAccepted = true; markDirty();
  $('#manualPanel').hidden = true;
  renderGps();
  toast(inGB(lat, lon) ? 'Location set' : 'Location set – note: that’s outside Great Britain');
}
function onPasteInput() {
  const txt = $('#manPaste').value; const out = $('#manPasteResult');
  if (!txt.trim()) { out.hidden = true; return; }
  const r = parseLocationText(txt);
  out.hidden = false;
  if (r.error) { out.textContent = r.error; out.className = 'small bad-text'; return; }
  $('#manLat').value = r.lat; $('#manLon').value = r.lon; S.form.manualSource = r.source;
  out.className = 'small ok-text';
  out.textContent = `Found ${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}${r.source === 'maps-link' ? ' from the Google Maps link' : ''}. Tap “Use this location”.`;
}
async function pasteFromClipboard() {
  try { const t = await navigator.clipboard.readText(); $('#manPaste').value = t; onPasteInput(); }
  catch (e) { toast('Long-press in the box and choose Paste'); $('#manPaste').focus(); }
}

/* ----- mileage ----- */
function updateMileage(from) {
  const e = formEls();
  if (from === 'chains') { const y = chainsToYards(e.chains.value); e.yards.value = y == null ? '' : y; }
  if (from === 'yards') { const c = yardsToChains(e.yards.value); e.chains.value = c == null ? '' : c; }
  const c = num(e.chains.value);
  e.chains.classList.toggle('invalid', c != null && (c < 0 || c >= CHAINS_PER_MILE));
  const m = num(e.miles.value);
  e.miles.classList.toggle('invalid', m != null && (m < 0 || !Number.isInteger(m)));
  const txt = fmtMileage(e.miles.value, e.chains.value);
  $('#mileageDisplay').textContent = txt ? (e.elr.value.trim() ? e.elr.value.trim().toUpperCase() + ' ' : '') + txt + (num(e.yards.value) != null ? ` (${num(e.yards.value)} yd)` : '') : '–';
}

/* ----- chainage helper ----- */
async function runChainHelper() {
  const box = $('#chainResult');
  const loc = currentLoc();
  box.hidden = false;
  if (!loc) { box.innerHTML = '<p class="bad-text">Set a location first (GPS, manual or Google Maps link).</p>'; return; }
  if (!navigator.onLine) { box.innerHTML = '<p class="bad-text">You’re offline – the milepost estimate needs a data connection. Enter the ELR and mileage manually.</p>'; return; }
  if (S.chainCtrl) S.chainCtrl.abort();
  const ctrl = new AbortController(); S.chainCtrl = ctrl;
  box.innerHTML = '<p><span class="spinner"></span> Asking OpenStreetMap for nearby mileposts… <button type="button" class="linkish" id="chainCancel">Cancel</button></p>';
  $('#chainBtn').disabled = true;
  try {
    const r = await estimateChainage(loc.lat, loc.lon, ctrl.signal);
    if (S.chainCtrl !== ctrl) return;
    renderChainResult(r);
  } catch (e) {
    if (S.chainCtrl !== ctrl) return;
    box.innerHTML = ctrl.signal.aborted ? '<p class="muted">Cancelled.</p>' : `<p class="bad-text">The OpenStreetMap lookup didn’t work (${esc(e.message || 'error')}). This helper is optional – enter the ELR and mileage manually.</p>`;
  } finally { if (S.chainCtrl === ctrl) S.chainCtrl = null; $('#chainBtn').disabled = false; }
}
function renderChainResult(r) {
  const box = $('#chainResult');
  let h = '<p class="approx"><b>⚠ Approximate – verify against NR records.</b> From OpenStreetMap; nothing is filled in unless you tap Use.</p>';
  if (r.elrCandidates.length) {
    h += '<p class="small"><b>Nearby lines</b></p><ul class="sugg">';
    r.elrCandidates.forEach(c => {
      h += `<li><span>${c.elr ? `<b>${esc(c.elr)}</b> ` : ''}${esc(c.name || '')} <span class="muted">· ${c.distM} m away</span></span>`;
      if (c.elr) h += ` <button type="button" class="chip" data-use-elr="${esc(c.elr)}">Use ELR ${esc(c.elr)}</button>`;
      c.tracks.slice(0, 4).forEach(t => { h += ` <button type="button" class="chip" data-use-track="${esc(t.ref)}">Track: ${esc(t.ref)}</button>`; });
      h += '</li>';
    });
    h += '</ul>';
    if (!r.elrCandidates.some(c => c.elr)) h += '<p class="small muted">The nearby line has no ELR tagged in OpenStreetMap.</p>';
  } else h += '<p class="small">No railway line found in OpenStreetMap within 120 m of this position.</p>';
  if (r.estimate) {
    const e = r.estimate;
    h += `<div class="estimate"><div>≈ <b>${esc((e.elr ? e.elr + ' ' : '') + fmtMileage(e.miles, e.chains))}</b> <span class="muted small">(confidence: ${e.confidence})</span></div>
      <p class="small muted">${e.bracketed ? 'Interpolated between' : 'Extrapolated from'} mileposts ${esc(e.from.map(p => p.miles + ' mi (' + p.distM + ' m away)').join(' and '))}; you are ~${e.offsetM} m from the line between them.${e.unitAssumed ? ' Unit assumed: ' + (e.unitAssumed === 'mi' ? 'miles' : 'km') + '.' : ''}</p>
      <button type="button" class="btn outline small" data-use-mileage="${e.miles}|${e.chains}|${esc(e.elr || '')}">Use ${esc(fmtMileage(e.miles, e.chains))}${e.elr ? ' + ELR ' + esc(e.elr) : ''}</button></div>`;
  } else if (r.nearestPost) {
    h += `<p class="small">Nearest milepost in OpenStreetMap: <b>${esc(String(r.nearestPost.miles))} mi</b>${r.nearestPost.elr ? ' (' + esc(r.nearestPost.elr) + ')' : ''}, ${r.nearestPost.distM} m away – not enough mileposts nearby to interpolate. Enter the mileage manually.</p>`;
  } else {
    h += `<p class="small">No mileposts are mapped in OpenStreetMap within 3 km${r.milepostsFound ? ' with a readable position' : ''}, so a mileage can’t be estimated. Enter it manually.</p>`;
  }
  box.innerHTML = h;
}
function useSuggestion(t) {
  const e = formEls();
  const confirmReplace = (el, v, label) => !el.value.trim() || el.value.trim().toUpperCase() === String(v).toUpperCase() || confirm(`Replace ${label} “${el.value.trim()}” with “${v}”?`);
  if (t.dataset.useElr) { if (confirmReplace(e.elr, t.dataset.useElr, 'ELR')) { e.elr.value = t.dataset.useElr; markDirty(); toast('ELR set to ' + t.dataset.useElr); } }
  else if (t.dataset.useTrack) { if (confirmReplace(e.track, t.dataset.useTrack, 'track ID')) { e.track.value = t.dataset.useTrack; markDirty(); toast('Track ID set'); } }
  else if (t.dataset.useMileage) {
    const [m, c, elr] = t.dataset.useMileage.split('|');
    const cur = fmtMileage(e.miles.value, e.chains.value);
    if (cur && !confirm(`Replace mileage ${cur} with ≈ ${fmtMileage(m, c)}?`)) return;
    e.miles.value = m; e.chains.value = c; updateMileage('chains');
    if (elr && !e.elr.value.trim()) e.elr.value = elr;
    markDirty(); toast('Approximate mileage filled in – please verify');
  }
  updateMileage();
}

/* ----- measurements ----- */
function renderMeasurements() {
  const f = S.form; const list = $('#measList');
  list.innerHTML = f.measurements.map((m, i) => `<div class="meas-row" data-i="${i}">
    <input class="m-name" list="measNames" placeholder="Name" value="${esc(m.name)}" aria-label="Measurement name">
    <input class="m-val" placeholder="Value" value="${esc(m.value)}" aria-label="Measurement value">
    <button type="button" class="icon-btn m-del" aria-label="Remove measurement">×</button></div>`).join('');
  const names = new Set(DEFAULT_MEAS_NAMES);
  S.records.forEach(r => (r.measurements || []).forEach(m => m.name && names.add(m.name)));
  $('#measNames').innerHTML = Array.from(names).map(n => `<option value="${esc(n)}">`).join('');
}

/* ----- photos ----- */
function renderPhotos() {
  const f = S.form; const list = $('#photoList');
  S.formUrls.forEach(u => URL.revokeObjectURL(u)); S.formUrls = [];
  list.innerHTML = f.photos.map((p, i) => { const u = URL.createObjectURL(thumbBlob(p)); S.formUrls.push(u); return `<div class="photo" data-i="${i}"><img src="${u}" alt="Photo ${i + 1}" data-view-photo="${i}"><button type="button" class="photo-del" aria-label="Remove photo">×</button></div>`; }).join('');
}
async function addPhotos(files) {
  const f = S.form; if (!f || !files || !files.length) return;
  $('#photoBusy').hidden = false;
  try {
    for (const file of Array.from(files)) {
      if (!/^image\//.test(file.type || 'image/')) continue;
      const exif = await readExifGps(file);
      try {
        const p = await compressPhoto(file);
        if (S.form !== f) return;
        f.photos.push(p); markDirty(); renderPhotos();
      } catch (e) { toast(e.message || 'Couldn’t add that photo'); continue; }
      if (exif && !currentLoc()) offerExif(exif);
    }
  } finally { $('#photoBusy').hidden = true; }
}
function offerExif(exif) {
  const box = $('#exifOffer'); S.form.exifOffer = exif;
  box.hidden = false;
  box.innerHTML = `<p><b>This photo has GPS data:</b> ${fmtCoord(exif.lat)}, ${fmtCoord(exif.lon)}${exif.accuracy ? ' ' + fmtAcc(exif.accuracy) : ''}. There’s no GPS fix yet – use the photo’s location?</p>
    <div class="btn-row"><button type="button" class="btn primary" id="exifUse">Use photo location</button><button type="button" class="btn outline" id="exifNo">No thanks</button></div>`;
}
function useExif() {
  const x = S.form.exifOffer; if (!x) return;
  gps.cancel();
  S.form.loc = { lat: x.lat, lon: x.lon, accuracy: x.accuracy || null, source: 'exif' }; S.form.locAccepted = true; markDirty();
  $('#exifOffer').hidden = true; renderGps(); toast('Using the photo’s location');
}
function viewPhoto(blob, caption) {
  const u = URL.createObjectURL(blob);
  openSheet(`<div class="photo-view"><img src="${u}" alt="${esc(caption || 'Photo')}"></div><div class="sheet-actions"><button class="btn big" type="button" data-close>Close</button></div>`, () => URL.revokeObjectURL(u));
}

/* ----- save / cancel ----- */
function readNumberField(el, label, { int = false, min = null, max = null } = {}) {
  const raw = el.value.trim(); if (!raw) return { ok: true, v: null };
  const v = num(raw);
  if (v == null || (int && !Number.isInteger(v)) || (min != null && v < min) || (max != null && v >= max)) { el.focus(); toast(`Check ${label}: “${raw}”`); el.classList.add('invalid'); return { ok: false }; }
  return { ok: true, v };
}
async function saveForm() {
  const f = S.form; if (!f || S.saving) return;
  const e = formEls();
  if (dict.state !== 'idle') dict.reset(); // keep whatever text has been dictated
  const re = readNumberField(e.re, 'distance from running edge'); if (!re.ok) return;
  const miles = readNumberField(e.miles, 'miles', { int: true, min: 0 }); if (!miles.ok) return;
  const chains = readNumberField(e.chains, 'chains (0–79.99)', { min: 0, max: CHAINS_PER_MILE }); if (!chains.ok) return;
  const pend = pendingFix();
  if (pend) { gps.stop(false); f.loc = { lat: round(pend.lat, 7), lon: round(pend.lon, 7), accuracy: round(pend.accuracy, 1), source: 'gps', at: pend.at }; f.locAccepted = true; }
  if (!f.loc || !f.locAccepted) {
    if (!confirm('No location has been set. Save without coordinates? (It won’t appear in KML/KMZ.)')) return;
  }
  gps.cancel();
  const tag = e.tag.value.trim() || 'Untitled';
  const rec = Object.assign({}, f.rec || {}, {
    id: f.id, tag, notes: e.notes.value.trim(),
    lat: f.loc && f.locAccepted ? f.loc.lat : null, lon: f.loc && f.locAccepted ? f.loc.lon : null,
    accuracy: f.loc && f.locAccepted ? f.loc.accuracy : null, locSource: f.loc && f.locAccepted ? f.loc.source : '',
    runningEdgeMm: re.v, measurements: f.measurements.filter(m => (m.name || '').trim() || String(m.value || '').trim()).map(m => ({ name: m.name.trim(), value: String(m.value).trim() })),
    elr: e.elr.value.trim().toUpperCase(), trackId: e.track.value.trim(),
    miles: miles.v, chains: chains.v, yards: chains.v == null ? null : chainsToYards(chains.v),
    surveyor: e.surveyor.value.trim(), createdAt: f.createdAt, updatedAt: new Date().toISOString(),
    rev: ((f.rec && f.rec.rev) || 0) + 1, syncedRev: (f.rec && f.rec.syncedRev) || 0
  });
  S.saving = true; $('#formSave').disabled = true;
  try {
    await DB.saveRecord(rec, f.photos);
  } catch (err) {
    console.warn('Save failed', err);
    toast('Couldn’t save: ' + (err && err.message || err), 5000);
    return;
  } finally { S.saving = false; $('#formSave').disabled = false; }
  Settings.set({ lastTag: tag, lastElr: rec.elr, lastTrackId: rec.trackId });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const wasNew = f.isNew;
  f.dirty = false;
  await refresh();
  toast(`Saved ${tag}${navigator.onLine ? '' : ' (offline – stored on this phone)'}`);
  if (wasNew) showView('home'); else openDetail(rec.id, { noPrev: true });
  Sync.kick('save');
}
function cancelForm() {
  const f = S.form;
  if (f && f.dirty && !confirm(f.isNew ? 'Discard this location?' : 'Discard your changes?')) return;
  const back = f && !f.isNew ? f.id : null;
  if (back) openDetail(back, { noPrev: true }); else showView('home');
}

/* ---------------- summary ---------------- */
function recordMatches(r, q) {
  if (!q) return true;
  const hay = [r.tag, r.notes, r.elr, r.trackId, recordMileage(r), r.surveyor, measurementsText(r), fmtDateTime(r.createdAt), r.runningEdgeMm].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
async function renderList() {
  const q = $('#search').value.trim();
  const recs = S.records.slice().sort(byNewest).filter(r => recordMatches(r, q));
  S.listUrls.forEach(u => URL.revokeObjectURL(u)); S.listUrls = [];
  $('#listCount').textContent = q ? `${recs.length} of ${S.records.length} locations` : `${S.records.length} location${S.records.length === 1 ? '' : 's'}`;
  const showSync = Sync.configured();
  $('#list').innerHTML = recs.length ? recs.map(r => `<button type="button" class="rec-item" data-id="${esc(r.id)}">
      <span class="thumb" data-photo="${esc((r.photoIds || [])[0] || '')}">${(r.photoIds || []).length ? '' : '<span aria-hidden="true">📍</span>'}</span>
      <span class="rec-main">
        <span class="rec-top"><b class="rec-tag">${esc(r.tag || 'Untitled')}</b>${showSync && isDirty(r) ? '<span class="badge unsynced">Not synced</span>' : ''}${!Number.isFinite(r.lat) ? '<span class="badge nogps">No GPS</span>' : ''}</span>
        <span class="rec-meta">${esc(fmtDateTime(r.createdAt))}${recordMileage(r) ? ' · ' + esc((r.elr ? r.elr + ' ' : '') + recordMileage(r)) : ''}${r.runningEdgeMm != null ? ' · RE ' + esc(r.runningEdgeMm) + ' mm' : ''}</span>
        ${r.notes ? `<span class="rec-notes">${esc(r.notes.slice(0, 110))}${r.notes.length > 110 ? '…' : ''}</span>` : ''}
      </span></button>`).join('')
    : `<div class="empty">${S.records.length ? 'No locations match your search.' : 'No locations yet. Tap <b>Mark Location</b> on the Home screen to add one.'}</div>`;
  for (const el of $$('#list .thumb[data-photo]')) {
    const id = el.dataset.photo; if (!id) continue;
    const p = await DB.get('photos', id).catch(() => null);
    const b = thumbBlob(p); if (!b) continue;
    const u = URL.createObjectURL(b); S.listUrls.push(u);
    el.innerHTML = `<img src="${u}" alt="">`;
  }
}

/* ---------------- detail ---------------- */
async function openDetail(id, opts = {}) {
  const r = await DB.get('records', id);
  if (!r) { toast('That location no longer exists'); showView('summary'); return; }
  S.detailId = id;
  S.detailUrls.forEach(u => URL.revokeObjectURL(u)); S.detailUrls = [];
  const photos = await DB.photosFor(id);
  const has = Number.isFinite(r.lat);
  const row = (k, v) => v === '' || v == null ? '' : `<tr><th>${esc(k)}</th><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`;
  const syncLine = Sync.configured() ? (isDirty(r) ? '<span class="badge unsynced">Not synced yet</span>' : `<span class="badge synced">Synced ${esc(fmtDateTime(r.syncedAt))}</span>`) : '';
  $('#detail').innerHTML = `
    <div class="card">
      <div class="detail-head"><h2>${esc(r.tag || 'Untitled')}</h2>${syncLine}</div>
      <p class="muted">${esc(fmtDateTimeSecs(r.createdAt))}${r.surveyor ? ' · ' + esc(r.surveyor) : ''}</p>
      ${has ? `<p class="coords"><b>${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}</b> <span class="acc ${accClass(r.accuracy)}">${r.accuracy != null ? fmtAcc(r.accuracy) : ''}</span> <span class="muted small">(${esc(SOURCE_LABEL[r.locSource] || r.locSource || '')})</span></p>
        <div class="grid2"><a class="btn outline" href="${mapsUrl(r.lat, r.lon)}" target="_blank" rel="noopener" id="dMaps">Open in Google Maps</a><a class="btn outline" href="${earthUrl(r.lat, r.lon)}" target="_blank" rel="noopener" id="dEarth">Open in Google Earth</a></div>
        <button type="button" class="linkish small" id="dCopy">Copy coordinates</button>` : '<p class="bad-text">No coordinates recorded.</p>'}
    </div>
    ${r.notes ? `<div class="card"><h3>Notes</h3><p class="notes-full">${esc(r.notes).replace(/\n/g, '<br>')}</p></div>` : ''}
    <div class="card"><table class="kv">
      ${row('Running edge', r.runningEdgeMm != null ? r.runningEdgeMm + ' mm' : '')}
      ${row('ELR', r.elr)}${row('Track ID', r.trackId)}
      ${row('Mileage', recordMileage(r) ? recordMileage(r) + (r.yards != null ? ` (${r.yards} yd)` : '') : '')}
      ${(r.measurements || []).map(m => row(m.name || 'Measurement', m.value)).join('')}
    </table></div>
    ${photos.length ? `<div class="card"><h3>Photos</h3><div class="photo-grid">${photos.map((p, i) => { const u = URL.createObjectURL(thumbBlob(p)); S.detailUrls.push(u); return `<img src="${u}" alt="Photo ${i + 1}" data-detail-photo="${esc(p.id)}">`; }).join('')}</div></div>` : ''}
    <div class="detail-actions">
      <button type="button" class="btn primary big" id="dEdit">✎ Edit</button>
      <button type="button" class="btn danger big" id="dDelete">Delete</button>
    </div>`;
  showView('detail', opts);
}
async function deleteRecord(id) {
  const r = await DB.get('records', id); if (!r) return;
  if (!confirm(`Delete “${r.tag || 'Untitled'}”? This removes it and its photos from this phone and can’t be undone.`)) return;
  await DB.deleteRecord(id, !!r.syncedAt);
  await refresh();
  toast('Deleted ' + (r.tag || 'location'));
  showView('summary', { noPrev: true });
  Sync.kick('delete');
}

/* ---------------- sheet (modal) ---------------- */
let sheetOnClose = null;
function openSheet(html, onClose) {
  closeSheet();
  const s = $('#sheet'); s.innerHTML = html; s.hidden = false; $('#sheetBackdrop').hidden = false;
  sheetOnClose = onClose || null;
  requestAnimationFrame(() => s.classList.add('open'));
}
function closeSheet() {
  const s = $('#sheet'); s.classList.remove('open'); s.hidden = true; $('#sheetBackdrop').hidden = true; s.innerHTML = '';
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; try { f(); } catch (e) { /* ignore */ } }
}

/* ---------------- exports ---------------- */
function openExportSheet() {
  openSheet(`<h2>Export</h2><p class="small muted">${S.records.length} location(s). Files are made on this phone.</p>
    <div class="grid2">
      <button class="btn outline big" type="button" data-export="kmz">KMZ<small>Google Earth + photos</small></button>
      <button class="btn outline big" type="button" data-export="kml">KML<small>Google Earth / Maps</small></button>
      <button class="btn outline big" type="button" data-export="xlsx">Excel<small>.xlsx</small></button>
      <button class="btn outline big" type="button" data-export="csv">CSV<small>spreadsheet</small></button>
      <button class="btn outline big" type="button" data-export="json">Full backup<small>JSON incl. photos</small></button>
    </div><div class="sheet-actions"><button class="btn big" type="button" data-close>Close</button></div>`);
}
async function doExport(kind) {
  if (S.exporting) return;
  const recs = await DB.all('records');
  if (!recs.length) { toast('Nothing to export yet'); return; }
  const noLoc = recs.filter(r => !Number.isFinite(r.lat)).length;
  S.exporting = true;
  openSheet(`<div class="busy"><span class="spinner big-spin"></span><p>Preparing ${kind.toUpperCase()}…</p></div>`);
  let file;
  try {
    const stamp = fileStamp();
    if (kind === 'kml') file = makeFile(buildKML(recs), `rail-survey_${stamp}.kml`, MIME.kml);
    else if (kind === 'kmz') file = makeFile(await buildKMZ(recs), `rail-survey_${stamp}.kmz`, MIME.kmz);
    else if (kind === 'csv') file = makeFile(buildCSV(recs), `rail-survey_${stamp}.csv`, MIME.csv);
    else if (kind === 'xlsx') file = makeFile(await buildXLSX(recs), `rail-survey_${stamp}.xlsx`, MIME.xlsx);
    else if (kind === 'json') file = makeFile(await buildBackup(), `rail-survey-backup_${stamp}.json`, MIME.json);
  } catch (e) {
    console.warn('Export failed', e); closeSheet(); toast('Export failed: ' + (e.message || e), 5000); return;
  } finally { S.exporting = false; }
  S.lastExport = file;
  const share = canShareFile(file);
  const label = { kml: 'KML', kmz: 'KMZ', csv: 'CSV', xlsx: 'Excel file', json: 'Backup' }[kind];
  openSheet(`<h2>${label} ready</h2>
    <p><b>${esc(file.name)}</b><br><span class="muted small">${fmtBytes(file.size)} · ${recs.length} location(s)${(kind === 'kml' || kind === 'kmz') && noLoc ? ` · ${noLoc} without coordinates left out` : ''}</span></p>
    <div class="sheet-actions">
      ${share ? '<button class="btn primary big" type="button" id="shareFile">Share…</button>' : ''}
      <button class="btn ${share ? 'outline' : 'primary'} big" type="button" id="downloadFile">Download</button>
      <button class="btn big" type="button" data-close>Close</button>
    </div>`);
}
async function deliver(how) {
  const file = S.lastExport; if (!file) return;
  if (how === 'share') {
    try { const r = await shareFile(file, 'Rail Survey export'); if (r === 'shared') { toast('Shared'); closeSheet(); } }
    catch (e) { console.info('Share failed, downloading instead', e && e.name); downloadFile(file); toast('Downloaded ' + file.name); }
  } else { downloadFile(file); toast('Downloaded ' + file.name); }
}
async function onRestoreFile(input) {
  const file = input.files && input.files[0]; input.value = '';
  if (!file) return;
  let text; try { text = await file.text(); } catch (e) { toast('Couldn’t read that file'); return; }
  let meta = null; try { meta = JSON.parse(text); } catch (e) { /* handled below */ }
  const n = meta && Array.isArray(meta.records) ? meta.records.length : 0;
  if (!confirm(`Restore ${n} location(s) from this backup${meta && meta.exportedAt ? ' made ' + fmtDateTime(meta.exportedAt) : ''}? Existing locations are kept; where both exist, the newer copy wins.`)) return;
  try { const r = await restoreBackup(text); await refresh(); toast(`Restored: ${r.added} added, ${r.updated} updated, ${r.skipped} kept (newer on phone), ${r.photos} photos`, 5000); Sync.kick('restore'); }
  catch (e) { toast(e.message || 'Restore failed', 5000); }
}

/* ---------------- settings & sync UI ---------------- */
function renderSettings() {
  const s = Settings.load();
  $('#sSurveyor').value = s.surveyor || '';
  $('#sSyncEnabled').checked = !!s.syncEnabled;
  $('#sScriptUrl').value = s.scriptUrl || '';
  $('#sToken').value = s.token || '';
  $('#appVersion').textContent = APP_VERSION_LABEL;
  updateSyncUI();
  if (window.caches) caches.keys().then(k => { $('#swVersion').textContent = k.find(x => x.startsWith('rail-survey-')) || 'not installed'; }).catch(() => {});
  if (navigator.storage && navigator.storage.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(null)])
      .then(([est, p]) => { $('#storageInfo').textContent = `Using ${fmtBytes(est.usage || 0)} on this device${p === true ? ' · storage is persistent' : p === false ? ' · install to Home Screen to protect storage' : ''}.`; }).catch(() => {});
  }
}
async function updateSyncUI() {
  const cfg = Sync.configured();
  let p = { total: 0, records: 0, deletes: 0 };
  try { p = await Sync.pending(); } catch (e) { /* ignore */ }
  const badge = $('#syncBadge');
  badge.hidden = !(cfg && (p.total > 0 || Sync.running));
  badge.textContent = Sync.running ? '⟳ syncing' : `⟳ ${p.total}`;
  badge.classList.toggle('busy', Sync.running);
  badge.setAttribute('aria-label', `${p.total} change(s) waiting to sync`);
  const tb = $('#tabBadge'); tb.hidden = !(cfg && p.records > 0); tb.textContent = p.records;
  $('#statUnsynced').textContent = cfg ? p.total : '–';
  $('#statSyncLabel').textContent = cfg ? 'to sync' : 'sync off';
  $('#statSyncWrap').classList.toggle('warn', cfg && p.total > 0);
  const st = $('#syncStatus');
  if (st) {
    const s = Settings.load();
    const parts = [];
    if (!cfg) parts.push(s.syncEnabled ? 'Add the URL and token to start syncing.' : 'Sync is off – data stays on this phone.');
    else {
      parts.push(Sync.running ? 'Syncing…' : p.total ? `${p.total} change(s) waiting to sync${navigator.onLine ? '' : ' (offline – will sync when signal returns)'}.` : 'Everything is synced.');
      if (s.lastSyncAt) parts.push('Last sync ' + fmtDateTime(s.lastSyncAt) + '.');
      if (s.lastSyncError && p.total) parts.push('Last problem: ' + s.lastSyncError);
    }
    st.textContent = parts.join(' ');
    st.classList.toggle('bad-text', !!(cfg && s.lastSyncError && p.total));
  }
  if (S.view === 'summary' && S.lastSyncRenderTotal !== p.total) { S.lastSyncRenderTotal = p.total; renderList(); }
}
function updateNet() {
  const on = navigator.onLine; const n = $('#netStatus');
  n.textContent = on ? 'Online' : 'Offline'; n.className = 'net ' + (on ? 'on' : 'off');
}

/* ---------------- service worker ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  S.swHadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.swHadController) $('#updateBanner').hidden = false;
    S.swHadController = true;
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => { S.swReg = reg; }).catch(e => console.info('Service worker registration failed', e));
  });
}

/* ---------------- bindings ---------------- */
function bind() {
  document.addEventListener('click', e => {
    const t = e.target;
    const tab = t.closest('.tab'); if (tab) { if (S.view === 'form') return; showView(tab.dataset.view); return; }
    const go = t.closest('[data-go]'); if (go) { if (go.dataset.go === 'export') openExportSheet(); else showView(go.dataset.go); return; }
    const ex = t.closest('[data-export]'); if (ex) { doExport(ex.dataset.export); return; }
    if (t.closest('[data-close]') || t.id === 'sheetBackdrop') { closeSheet(); return; }
    if (t.closest('#shareFile')) { deliver('share'); return; }
    if (t.closest('#downloadFile')) { deliver('download'); return; }
    const item = t.closest('.rec-item'); if (item) { openDetail(item.dataset.id); return; }
    if (t.closest('#lastCard')) { openDetail($('#lastCard').dataset.id); return; }
    if (t.closest('#backBtn')) { showView(S.prev === 'detail' || S.prev === 'form' ? 'summary' : S.prev, { noPrev: true }); return; }
    // detail
    if (t.closest('#dEdit')) { DB.get('records', S.detailId).then(r => r && openForm(r)); return; }
    if (t.closest('#dDelete')) { deleteRecord(S.detailId); return; }
    if (t.closest('#dCopy')) { const r = S.records.find(x => x.id === S.detailId); if (r) navigator.clipboard.writeText(`${r.lat}, ${r.lon}`).then(() => toast('Coordinates copied'), () => toast(`${r.lat}, ${r.lon}`, 5000)); return; }
    const dp = t.closest('[data-detail-photo]'); if (dp) { DB.get('photos', dp.dataset.detailPhoto).then(p => p && viewPhoto(photoBlob(p))); return; }
    // form
    if (!S.form) return;
    if (t.closest('#gpsAccept')) acceptFix();
    else if (t.closest('#gpsRefine')) refineFix();
    else if (t.closest('#gpsManualBtn')) { const mp = $('#manualPanel'); mp.hidden = !mp.hidden; if (!mp.hidden) $('#manPaste').focus(); }
    else if (t.closest('#manUse')) applyManual();
    else if (t.closest('#manPasteBtn')) pasteFromClipboard();
    else if (t.closest('#chainBtn')) runChainHelper();
    else if (t.closest('#chainCancel')) { if (S.chainCtrl) S.chainCtrl.abort(); }
    else if (t.closest('[data-use-elr],[data-use-track],[data-use-mileage]')) useSuggestion(t.closest('[data-use-elr],[data-use-track],[data-use-mileage]'));
    else if (t.closest('[data-tag]')) { $('#fTag').value = t.closest('[data-tag]').dataset.tag; markDirty(); }
    else if (t.closest('#addMeas')) { S.form.measurements.push({ name: '', value: '' }); renderMeasurements(); markDirty(); const rows = $$('#measList .m-name'); rows[rows.length - 1].focus(); }
    else if (t.closest('.m-del')) { const i = +t.closest('.meas-row').dataset.i; S.form.measurements.splice(i, 1); renderMeasurements(); markDirty(); }
    else if (t.closest('.photo-del')) { const i = +t.closest('.photo').dataset.i; if (confirm('Remove this photo?')) { S.form.photos.splice(i, 1); renderPhotos(); markDirty(); } }
    else if (t.closest('[data-view-photo]')) { const p = S.form.photos[+t.closest('[data-view-photo]').dataset.viewPhoto]; if (p) viewPhoto(photoBlob(p)); }
    else if (t.closest('#exifUse')) useExif();
    else if (t.closest('#exifNo')) $('#exifOffer').hidden = true;
    else if (t.closest('#formSave')) saveForm();
    else if (t.closest('#formCancel')) cancelForm();
    else if (t.closest('#dictBtn')) dict.toggle();
    else if (t.closest('#dictCancel')) dict.cancel();
  });
  $('#markBtn').addEventListener('click', () => openForm(null));
  $('#recForm').addEventListener('submit', e => e.preventDefault());
  $('#recForm').addEventListener('input', e => {
    markDirty();
    const t = e.target;
    if (t.id === 'fChains') updateMileage('chains');
    else if (t.id === 'fYards') updateMileage('yards');
    else if (t.id === 'fMiles' || t.id === 'fElr') updateMileage();
    else if (t.id === 'manPaste') onPasteInput();
    else if (t.classList.contains('m-name') || t.classList.contains('m-val')) {
      const i = +t.closest('.meas-row').dataset.i; const m = S.form.measurements[i];
      if (m) m[t.classList.contains('m-name') ? 'name' : 'value'] = t.value;
    }
    if (t.classList.contains('invalid') && t.id !== 'fChains' && t.id !== 'fMiles') t.classList.remove('invalid');
  });
  $('#photoCam').addEventListener('change', e => { addPhotos(e.target.files).finally(() => { e.target.value = ''; }); });
  $('#photoLib').addEventListener('change', e => { addPhotos(e.target.files).finally(() => { e.target.value = ''; }); });
  $('#search').addEventListener('input', () => renderList());
  $('#dismissInstall').addEventListener('click', () => { Settings.set({ installDismissed: true }); $('#installHint').hidden = true; });
  $('#reloadBtn').addEventListener('click', () => { if (S.form && S.form.dirty && !confirm('You have an unsaved location. Reload anyway?')) return; location.reload(); });
  $('#syncBadge').addEventListener('click', () => { if (S.view === 'form') return; showView('settings'); setTimeout(() => $('#syncCard').scrollIntoView({ block: 'start' }), 60); });

  // settings
  $('#sSurveyor').addEventListener('change', e => { Settings.set({ surveyor: e.target.value.trim() }); toast('Name saved'); });
  $('#sScriptUrl').addEventListener('change', e => { Settings.set({ scriptUrl: e.target.value.trim(), lastSyncError: '' }); updateSyncUI(); });
  $('#sToken').addEventListener('change', e => { Settings.set({ token: e.target.value.trim(), lastSyncError: '' }); updateSyncUI(); });
  $('#sShowToken').addEventListener('change', e => { $('#sToken').type = e.target.checked ? 'text' : 'password'; });
  $('#sSyncEnabled').addEventListener('change', e => {
    Settings.set({ syncEnabled: e.target.checked });
    updateSyncUI(); refresh();
    if (e.target.checked) { if (Sync.configured()) Sync.kick('enabled'); else toast('Now add the web app URL and token'); }
  });
  $('#testConn').addEventListener('click', async () => {
    Settings.set({ scriptUrl: $('#sScriptUrl').value.trim(), token: $('#sToken').value.trim() });
    const st = $('#syncStatus'); st.classList.remove('bad-text'); st.textContent = 'Testing…';
    if (!navigator.onLine) { st.textContent = 'You’re offline – try again with signal.'; return; }
    try { const j = await Sync.test(); st.textContent = `✓ Connected to “${j.spreadsheet || 'your sheet'}”${j.rows != null ? ` (${j.rows} row${j.rows === 1 ? '' : 's'} so far)` : ''}. Script ${j.version || ''}`; st.classList.remove('bad-text'); }
    catch (e) { st.textContent = '✗ ' + (e.message || e); st.classList.add('bad-text'); }
  });
  $('#syncNow').addEventListener('click', async () => {
    Settings.set({ scriptUrl: $('#sScriptUrl').value.trim(), token: $('#sToken').value.trim() });
    if (!Settings.get('syncEnabled')) { toast('Tick “Sync to my Google Sheet” first'); return; }
    if (!Sync.configured()) { toast('Add the web app URL and token first'); return; }
    if (!navigator.onLine) { toast('Offline – will sync when signal returns'); return; }
    try { const r = await Sync.run('manual'); await refresh(); toast(r && r.done ? `Synced ${r.done} change(s)` : r && r.skipped === 'busy' ? 'Sync already running…' : 'Everything is already synced'); }
    catch (e) { await refresh(); toast('Sync problem: ' + (e.message || e), 5000); }
  });
  $('#backupBtn').addEventListener('click', () => doExport('json'));
  $('#restoreInput').addEventListener('change', e => onRestoreFile(e.target));
  $('#clearAll').addEventListener('click', async () => {
    if (!confirm(`Delete ALL ${S.records.length} location(s) and photos from this phone? Make a backup first if unsure.`)) return;
    const typed = prompt('This can’t be undone. Type DELETE to confirm.');
    if ((typed || '').trim().toUpperCase() !== 'DELETE') { toast('Not deleted'); return; }
    await DB.clearAll(); Settings.set({ lastTag: '', lastSyncError: '' }); await refresh(); toast('All survey data cleared');
  });
  $('#checkUpdate').addEventListener('click', async () => {
    if (!S.swReg) { toast('Offline cache not active yet'); return; }
    try { await S.swReg.update(); toast(S.swReg.installing || S.swReg.waiting ? 'Updating…' : 'You have the latest version'); } catch (e) { toast('Couldn’t check – are you online?'); }
  });

  // connectivity & lifecycle
  window.addEventListener('online', () => { updateNet(); updateSyncUI(); Sync.kick('online'); });
  window.addEventListener('offline', () => { updateNet(); updateSyncUI(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { Sync.kick('visible'); }
    else if (dict.state !== 'idle') dict.stop();
  });
  window.addEventListener('beforeunload', e => { if (S.form && S.form.dirty) { e.preventDefault(); e.returnValue = ''; } });
  Sync.onChange(() => updateSyncUI());
  setInterval(() => { if (navigator.onLine && Sync.configured() && !Sync.running) Sync.pending().then(p => { if (p.total) Sync.kick('interval'); }).catch(() => {}); }, 60000);
}

async function init() {
  $('#appVersion').textContent = APP_VERSION_LABEL;
  gps = new GpsCapture(() => renderGps());
  dict = new Dictation({ textarea: $('#fNotes'), button: $('#dictBtn'), cancelButton: $('#dictCancel'), status: $('#dictStatus') });
  bind();
  updateNet();
  registerSW();
  try { await refresh(); }
  catch (e) { console.warn(e); toast('Storage problem: ' + (e.message || e), 6000); }
  Sync.kick('open');
}
document.addEventListener('DOMContentLoaded', init);
