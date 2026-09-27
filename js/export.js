/* Rail Survey – on-device exports: KML, KMZ (with photos), Excel .xlsx (hand-written OOXML via JSZip), CSV and JSON backup/restore. */
'use strict';

const MIME = {
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  json: 'application/json'
};

const xmlEsc = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cdata = s => '<![CDATA[' + String(s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
function measurementsText(r) { return (r.measurements || []).filter(m => m && (m.name || m.value)).map(m => `${m.name || '?'}=${m.value == null ? '' : m.value}`).join('; '); }
function hasLoc(r) { return r && Number.isFinite(r.lat) && Number.isFinite(r.lon); }
function sortedRecords(records) { return records.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); }
function locSourceLabel(s) { return { gps: 'GPS', manual: 'Manual entry', 'maps-link': 'Google Maps link', exif: 'Photo EXIF GPS' }[s] || (s || ''); }

/* ---------------- KML / KMZ ---------------- */
function placemarkDescription(r, photoFiles) {
  const rows = [];
  const add = (k, v) => { if (v !== '' && v != null) rows.push(`<tr><th align="left" valign="top">${xmlEsc(k)}</th><td>${xmlEsc(v).replace(/\n/g, '<br>')}</td></tr>`); };
  add('Notes', r.notes);
  add('Distance from running edge', r.runningEdgeMm != null ? r.runningEdgeMm + ' mm' : '');
  (r.measurements || []).filter(m => m && (m.name || m.value)).forEach(m => add(m.name || 'Measurement', m.value));
  add('ELR', r.elr);
  add('Track ID', r.trackId);
  add('Mileage', recordMileage(r) + (r.yards != null ? ` (${r.yards} yd)` : ''));
  add('Timestamp', fmtDateTimeSecs(r.createdAt));
  add('GPS accuracy', r.accuracy != null ? fmtAcc(r.accuracy) : '');
  add('Location source', locSourceLabel(r.locSource));
  add('Coordinates', hasLoc(r) ? `${fmtCoord(r.lat)}, ${fmtCoord(r.lon)}` : '');
  add('Surveyor', r.surveyor);
  let html = `<table border="0" cellpadding="3">${rows.join('')}</table>`;
  if (photoFiles && photoFiles.length) html += photoFiles.map(f => `<p><img src="${xmlEsc(f)}" width="480"/></p>`).join('');
  else if (r.photoIds && r.photoIds.length) html += `<p><i>${r.photoIds.length} photo(s) – included in the KMZ export.</i></p>`;
  return html;
}
function buildKML(records, opts = {}) {
  const recs = sortedRecords(records).filter(hasLoc);
  const title = opts.title || `Rail Survey ${fmtDateTime(new Date().toISOString()).slice(0, 10)}`;
  const pms = recs.map(r => {
    const ext = [['id', r.id], ['ELR', r.elr], ['Track ID', r.trackId], ['Miles', r.miles], ['Chains', r.chains], ['Yards', r.yards], ['Running edge (mm)', r.runningEdgeMm], ['Other measurements', measurementsText(r)], ['Accuracy (m)', r.accuracy != null ? round(r.accuracy, 1) : ''], ['Timestamp', r.createdAt], ['Surveyor', r.surveyor]]
      .filter(([, v]) => v !== '' && v != null).map(([k, v]) => `<Data name="${xmlEsc(k)}"><value>${xmlEsc(v)}</value></Data>`).join('');
    return `  <Placemark id="p-${xmlEsc(r.id)}">
    <name>${xmlEsc(r.tag || 'Untitled')}</name>
    <description>${cdata(placemarkDescription(r, opts.photoMap ? opts.photoMap[r.id] : null))}</description>
    <TimeStamp><when>${xmlEsc(r.createdAt)}</when></TimeStamp>
    <styleUrl>#railSurveyPoint</styleUrl>
    <ExtendedData>${ext}</ExtendedData>
    <Point><coordinates>${Number(r.lon).toFixed(7)},${Number(r.lat).toFixed(7)},0</coordinates></Point>
  </Placemark>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${xmlEsc(title)}</name>
  <description>${xmlEsc(`Exported from Rail Survey ${APP_VERSION_LABEL} on ${fmtDateTime(new Date().toISOString())}. ${recs.length} location(s).`)}</description>
  <Style id="railSurveyPoint">
    <IconStyle><color>ff0070ff</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/orange-circle.png</href></Icon></IconStyle>
    <LabelStyle><scale>0.9</scale></LabelStyle>
  </Style>
${pms}
</Document>
</kml>
`;
}
async function buildKMZ(records) {
  const zip = new JSZip();
  const photoMap = {};
  const files = zip.folder('files');
  for (const r of sortedRecords(records).filter(hasLoc)) {
    const photos = await DB.photosFor(r.id);
    photoMap[r.id] = [];
    photos.forEach((p, i) => {
      const fname = `files/${safeName(r.tag || 'location')}_${r.id.slice(0, 8)}_${i + 1}.jpg`;
      files.file(fname.slice(6), p.data, { binary: true });
      photoMap[r.id].push(fname);
    });
  }
  zip.file('doc.kml', buildKML(records, { photoMap }));
  const blob = await zip.generateAsync({ type: 'blob', mimeType: MIME.kmz, compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return blob;
}
function safeName(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'location'; }

/* ---------------- table rows (shared by CSV + XLSX) ---------------- */
const TABLE_COLUMNS = [
  ['id', r => r.id],
  ['Location name', r => r.tag || ''],
  ['Notes', r => r.notes || ''],
  ['Lat', r => hasLoc(r) ? round(r.lat, 7) : null],
  ['Long', r => hasLoc(r) ? round(r.lon, 7) : null],
  ['Accuracy (m)', r => r.accuracy != null ? round(r.accuracy, 1) : null],
  ['Distance from running edge (mm)', r => r.runningEdgeMm != null ? r.runningEdgeMm : null],
  ['Other measurements', r => measurementsText(r)],
  ['ELR', r => r.elr || ''],
  ['Track ID', r => r.trackId || ''],
  ['Miles', r => r.miles != null ? r.miles : null],
  ['Chains', r => r.chains != null ? r.chains : null],
  ['Yards', r => r.yards != null ? r.yards : null],
  ['Mileage', r => recordMileage(r)],
  ['Timestamp', r => r.createdAt, 'date'],
  ['Surveyor', r => r.surveyor || ''],
  ['Location source', r => locSourceLabel(r.locSource)],
  ['Photos', r => (r.photoIds || []).length],
  ['Google Maps link', r => hasLoc(r) ? mapsUrl(r.lat, r.lon) : '']
];

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // guard against spreadsheet formula injection
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCSV(records) {
  const recs = sortedRecords(records);
  const head = TABLE_COLUMNS.map(c => c[0]);
  const lines = [head.map(csvCell).join(',')];
  recs.forEach(r => lines.push(TABLE_COLUMNS.map(([, f, kind]) => kind === 'date' ? csvCell(fmtDateTimeSecs(f(r))) : csvCell(f(r))).join(',')));
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens UTF-8 correctly
}

/* ---------------- XLSX (minimal SpreadsheetML written by hand, zipped with JSZip) ---------------- */
function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function excelDate(iso) { const d = new Date(iso); if (isNaN(d)) return null; return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569; }
function sheetXML(rows, widths) {
  // rows: array of arrays of {v, t:'s'|'n'|'d', s:style}
  const out = rows.map((row, ri) => `<row r="${ri + 1}">` + row.map((cell, ci) => {
    const ref = colName(ci) + (ri + 1);
    if (cell == null || cell.v == null || cell.v === '') return '';
    const st = cell.s ? ` s="${cell.s}"` : '';
    if (cell.t === 'n' && Number.isFinite(Number(cell.v))) return `<c r="${ref}"${st}><v>${Number(cell.v)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(cell.v)}</t></is></c>`;
  }).join('') + '</row>').join('');
  const cols = widths ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
  const lastRef = colName(Math.max(0, (rows[0] || []).length - 1)) + Math.max(1, rows.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastRef}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${out}</sheetData>${rows.length > 1 ? `<autoFilter ref="A1:${lastRef}"/>` : ''}</worksheet>`;
}
async function buildXLSX(records) {
  const recs = sortedRecords(records);
  const H = 1, WRAP = 2, DATE = 3, COORD = 4;
  const header = TABLE_COLUMNS.map(c => ({ v: c[0], t: 's', s: H }));
  const body = recs.map(r => TABLE_COLUMNS.map(([name, f, kind]) => {
    const v = f(r);
    if (kind === 'date') { const n = excelDate(v); return n == null ? { v: v, t: 's' } : { v: n, t: 'n', s: DATE }; }
    if (typeof v === 'number') return { v, t: 'n', s: (name === 'Lat' || name === 'Long') ? COORD : 0 };
    return { v, t: 's', s: name === 'Notes' || name === 'Other measurements' ? WRAP : 0 };
  }));
  const summary = sheetXML([header, ...body], [38, 18, 50, 12, 12, 11, 16, 34, 8, 12, 8, 8, 8, 12, 19, 16, 16, 8, 50]);
  const mrows = [[{ v: 'Location name', t: 's', s: H }, { v: 'Measurement', t: 's', s: H }, { v: 'Value', t: 's', s: H }, { v: 'Mileage', t: 's', s: H }, { v: 'id', t: 's', s: H }]];
  recs.forEach(r => {
    if (r.runningEdgeMm != null) mrows.push([{ v: r.tag, t: 's' }, { v: 'Distance from running edge (mm)', t: 's' }, { v: r.runningEdgeMm, t: 'n' }, { v: recordMileage(r), t: 's' }, { v: r.id, t: 's' }]);
    (r.measurements || []).filter(m => m && (m.name || m.value)).forEach(m => {
      const n = num(m.value);
      mrows.push([{ v: r.tag, t: 's' }, { v: m.name, t: 's' }, n != null && String(m.value).trim() === String(n) ? { v: n, t: 'n' } : { v: m.value, t: 's' }, { v: recordMileage(r), t: 's' }, { v: r.id, t: 's' }]);
    });
  });
  const meas = sheetXML(mrows, [18, 34, 14, 12, 38]);
  const sheets = [['Summary', summary], ['Measurements', meas]];
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Rail Survey export</dc:title><dc:creator>${xmlEsc(Settings.get('surveyor') || 'Rail Survey')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Rail Survey ${xmlEsc(APP_VERSION_LABEL)}</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${s[0]}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${recs.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Summary!$A$1:$${colName(TABLE_COLUMNS.length - 1)}$${recs.length + 1}</definedName></definedNames>` : ''}</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0000000"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s[1]));
  return zip.generateAsync({ type: 'blob', mimeType: MIME.xlsx, compression: 'DEFLATE' });
}

/* ---------------- JSON backup / restore ---------------- */
async function buildBackup() {
  const records = await DB.all('records');
  const photos = await DB.all('photos');
  const tombstones = await DB.all('tombstones');
  return JSON.stringify({
    format: 'rail-survey-backup', formatVersion: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    surveyor: Settings.get('surveyor') || '',
    records, tombstones,
    photos: photos.map(p => Object.assign({}, p, { data: p.data ? arrayBufferToBase64(p.data) : null, thumb: p.thumb ? arrayBufferToBase64(p.thumb) : null }))
  });
}
function b64ToArrayBuffer(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8.buffer; }
/** Merge a backup into the database. Records with the same id are replaced only if the backup copy is newer. */
async function restoreBackup(text) {
  let data; try { data = JSON.parse(text); } catch (e) { throw new Error('That file isn’t valid JSON.'); }
  if (!data || data.format !== 'rail-survey-backup' || !Array.isArray(data.records)) throw new Error('That isn’t a Rail Survey backup file.');
  let added = 0, updated = 0, skipped = 0, photos = 0;
  const existing = new Map((await DB.all('records')).map(r => [r.id, r]));
  const photosByRec = {};
  (data.photos || []).forEach(p => { if (p && p.id && p.recordId && p.data) (photosByRec[p.recordId] = photosByRec[p.recordId] || []).push(p); });
  for (const r of data.records) {
    if (!r || !r.id) continue;
    const cur = existing.get(r.id);
    if (cur && String(cur.updatedAt || '') > String(r.updatedAt || '')) { skipped++; continue; }
    const ph = (photosByRec[r.id] || []).map(p => Object.assign({}, p, { data: b64ToArrayBuffer(p.data), thumb: p.thumb ? b64ToArrayBuffer(p.thumb) : null }));
    photos += ph.length;
    await DB.saveRecord(Object.assign({}, r), ph);
    cur ? updated++ : added++;
  }
  return { added, updated, skipped, photos };
}

/* ---------------- delivery: Web Share with files, else download ---------------- */
function makeFile(blobOrText, name, type) {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  try { return new File([blob], name, { type: type || blob.type }); } catch (e) { blob.name = name; return blob; }
}
function canShareFile(file) {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
}
async function shareFile(file, title) {
  try { await navigator.share({ files: [file], title: title || file.name }); return 'shared'; }
  catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; throw e; }
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name || 'rail-survey-export'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
