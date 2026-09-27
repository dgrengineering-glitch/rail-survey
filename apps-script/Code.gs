/**
 * Rail Survey – Google Sheet sync endpoint (Google Apps Script web app).
 *
 * Deploy this from YOUR OWN Google account, inside a Google Sheet:
 *   1. Create a new Google Sheet (sheets.new). Extensions › Apps Script. Replace the sample code with this file. Save.
 *   2. Run the function `setup` once from the toolbar and approve the permissions (Sheets + Drive).
 *   3. Back in the Sheet, use the menu  Rail Survey › Set sync token…  and enter a long secret of your choosing
 *      (or type it into SYNC_TOKEN below – the menu value wins if both are set).
 *   4. Deploy › New deployment › type "Web app". Execute as: Me. Who has access: Anyone. Deploy, copy the /exec URL.
 *   5. In the Rail Survey app › Settings › Google Sheet sync: tick the box, paste the URL and the token, Test connection.
 * After editing this code later, use Deploy › Manage deployments › Edit (pencil) › Version: New version › Deploy,
 * so the web app URL stays the same.
 *
 * The app sends text/plain POST requests (no CORS preflight) with a JSON body:
 *   { token, action: 'ping' | 'upsert' | 'photo' | 'delete', ... }
 * Every request without the correct token is refused.
 */

// Optional: paste your secret token here instead of using the Sheet menu (at least 12 characters).
var SYNC_TOKEN = '';

var SHEET_NAME = 'Locations';
var PHOTO_FOLDER_NAME = 'Rail Survey Photos';
var SCRIPT_VERSION = '0.1.0';
var MAX_PHOTO_BYTES = 12 * 1024 * 1024;
var HEADERS = [
  'id', 'location name', 'notes', 'lat', 'long', 'accuracy', 'distance from running edge mm', 'other measurements',
  'ELR', 'track ID', 'miles', 'chains', 'yards', 'timestamp', 'photo link',
  'surveyor', 'mileage', 'google maps link', 'location source', 'updated at', 'synced at'
];

/* ---------------- menu & one-off setup ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rail Survey')
    .addItem('Set sync token…', 'menuSetToken')
    .addItem('Set up sheet & photo folder', 'setup')
    .addItem('Show setup status', 'menuStatus')
    .addToUi();
}

function menuSetToken() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Rail Survey – sync token', 'Choose a long secret phrase (at least 12 characters). Enter exactly the same token in the Rail Survey app › Settings.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var t = String(res.getResponseText() || '').trim();
  if (t.length < 12) { ui.alert('That token is too short – use at least 12 characters.'); return; }
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', t);
  ui.alert('Token saved. Now deploy as a web app (Deploy › New deployment › Web app, access: Anyone) if you haven’t already.');
}

function menuStatus() {
  var ui = SpreadsheetApp.getUi();
  var folder = getFolder_();
  ui.alert('Rail Survey sync ' + SCRIPT_VERSION + '\n\nToken set: ' + (getToken_() ? 'yes' : 'NO – use Set sync token…') +
    '\nSheet: ' + SHEET_NAME + ' (' + Math.max(0, getSheet_().getLastRow() - 1) + ' rows)\nPhoto folder: ' + folder.getName() + ' – ' + folder.getUrl());
}

/** Run once from the Apps Script editor: creates the Locations sheet (with headers) and the Drive photo folder. */
function setup() {
  var sheet = getSheet_();
  var folder = getFolder_();
  var msg = 'Rail Survey setup done. Sheet "' + sheet.getName() + '" ready; photos folder: ' + folder.getUrl() +
    (getToken_() ? '' : '\nNEXT: set a token via the Sheet menu Rail Survey › Set sync token… (reload the Sheet to see the menu).');
  Logger.log(msg);
  return msg;
}

/* ---------------- web app entry points ---------------- */
function doGet() {
  return json_({ ok: true, app: 'rail-survey-sync', version: SCRIPT_VERSION, message: 'Rail Survey sync endpoint is running. The app talks to it with POST requests.' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, code: 'bad_request', error: 'Request was not valid JSON.' }); }

  var token = getToken_();
  if (!token) return json_({ ok: false, code: 'no_token', error: 'No sync token has been set in the Google Sheet yet – use the Sheet menu Rail Survey › Set sync token…' });
  if (!safeEqual_(String(req.token || ''), token)) return json_({ ok: false, code: 'bad_token', error: 'Wrong token – it must match the one set in the Google Sheet.' });

  try {
    switch (req.action) {
      case 'ping': {
        var sh = getSheet_();
        return json_({ ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(), sheet: SHEET_NAME, rows: Math.max(0, sh.getLastRow() - 1), version: SCRIPT_VERSION });
      }
      case 'upsert': return json_(withLock_(function () { return upsert_(req.record); }));
      case 'delete': return json_(withLock_(function () { return deleteRow_(req.id); }));
      case 'photo': return json_(savePhoto_(req));
      default: return json_({ ok: false, code: 'bad_action', error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, code: 'server', error: String((err && err.message) || err) });
  }
}

/* ---------------- actions ---------------- */
function upsert_(r) {
  if (!r || !isId_(r.id)) return { ok: false, code: 'bad_record', error: 'Record is missing a valid id.' };
  var sheet = getSheet_();
  var links = Array.isArray(r.photoLinks) ? r.photoLinks.filter(function (u) { return /^https:\/\//.test(u); }) : [];
  var ts = r.timestamp ? new Date(r.timestamp) : '';
  var row = [
    r.id, text_(r.tag), text_(r.notes), numOrBlank_(r.lat), numOrBlank_(r.lon), numOrBlank_(r.accuracy),
    numOrBlank_(r.runningEdgeMm), text_(r.measurements), text_(r.elr), text_(r.trackId),
    numOrBlank_(r.miles), numOrBlank_(r.chains), numOrBlank_(r.yards),
    ts && !isNaN(ts.getTime()) ? ts : text_(r.timestamp), links.join('\n'),
    text_(r.surveyor), text_(r.mileage), /^https:\/\//.test(r.mapsUrl || '') ? r.mapsUrl : '', text_(r.locSource),
    r.updatedAt ? new Date(r.updatedAt) : '', new Date()
  ];
  var found = findRow_(sheet, r.id);
  if (found) sheet.getRange(found, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true, id: r.id, row: found || sheet.getLastRow(), updated: !!found };
}

function deleteRow_(id) {
  if (!isId_(id)) return { ok: false, code: 'bad_record', error: 'Missing a valid id.' };
  var sheet = getSheet_();
  var found = findRow_(sheet, id);
  if (found) sheet.deleteRow(found);
  return { ok: true, id: id, deleted: !!found }; // photos are left in Drive on purpose
}

function savePhoto_(req) {
  if (!isId_(req.recordId) || !isId_(req.photoId)) return { ok: false, code: 'bad_photo', error: 'Photo is missing ids.' };
  if (!req.data || typeof req.data !== 'string') return { ok: false, code: 'bad_photo', error: 'Photo has no data.' };
  var folder = getFolder_();
  var name = req.photoId + '_' + String(req.filename || 'photo.jpg').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  var existing = folder.getFilesByName(name);          // idempotent: a retried upload returns the same file
  var file = existing.hasNext() ? existing.next() : null;
  if (!file) {
    var bytes = Utilities.base64Decode(req.data);
    if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, code: 'too_big', error: 'Photo is too large.' };
    var mime = /^image\/(jpeg|png|webp)$/.test(req.mime || '') ? req.mime : 'image/jpeg';
    file = folder.createFile(Utilities.newBlob(bytes, mime, name));
    file.setDescription('Rail Survey photo for record ' + req.recordId + (req.tag ? ' (' + req.tag + ')' : ''));
  }
  var shared = true;
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (err) { shared = false; } // some Google Workspace domains block link sharing – the link then works for you only
  return { ok: true, id: file.getId(), url: file.getUrl(), shared: shared };
}

/* ---------------- helpers ---------------- */
function getToken_() {
  var p = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  var t = String(p || SYNC_TOKEN || '').trim();
  return t.length >= 12 ? t : '';
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* deleted – make a new one */ } }
  var folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function findRow_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var cell = sheet.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function isId_(s) { return typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s); }
function numOrBlank_(v) { var n = Number(v); return v === '' || v === null || v === undefined || !isFinite(n) ? '' : n; }
function text_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;  // stop text being treated as a formula
}
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
