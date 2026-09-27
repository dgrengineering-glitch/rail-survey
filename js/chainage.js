/* Rail Survey – optional online helper: estimate ELR & mileage from OpenStreetMap (Overpass API).
   Everything returned here is APPROXIMATE and only ever shown as a suggestion; nothing is filled in
   unless the user taps to accept it. */
'use strict';

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let OVERPASS_TIMEOUT_MS = 20000;        // per endpoint
let OVERPASS_TOTAL_MS = 40000;          // give up after this, whatever happens
const MILEPOST_RADIUS_M = 3000;
const LINE_RADIUS_M = 120;
const ELR_RE = /^[A-Z]{2,4}[0-9]?$/;

function overpassQuery(lat, lon) {
  const d = 0.03; // clip returned geometry to a ~3.3 km box to keep replies small
  return `[out:json][timeout:18];
(
  node(around:${MILEPOST_RADIUS_M},${lat},${lon})["railway"="milestone"];
  way(around:${LINE_RADIUS_M},${lat},${lon})["railway"~"^(rail|light_rail|narrow_gauge|construction|disused)$"];
);
out tags geom(${(lat - d).toFixed(5)},${(lon - d * 1.6).toFixed(5)},${(lat + d).toFixed(5)},${(lon + d * 1.6).toFixed(5)});`;
}

async function fetchOverpass(query, signal) {
  let lastErr = null; const started = Date.now(); const tried = [];
  for (const ep of OVERPASS_ENDPOINTS) {
    if (signal && signal.aborted) throw new Error('cancelled');
    const left = OVERPASS_TOTAL_MS - (Date.now() - started);
    if (left < 3000) break;
    const t = withTimeout(Math.min(OVERPASS_TIMEOUT_MS, left), signal);
    try {
      // application/x-www-form-urlencoded is a "simple" request – no CORS preflight.
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, signal: t.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !Array.isArray(json.elements)) throw new Error('Unexpected reply');
      return { json, endpoint: ep };
    } catch (e) {
      lastErr = e; tried.push(new URL(ep).hostname + ': ' + (t.signal.aborted ? 'timed out' : (e && e.message) || 'failed'));
      if (signal && signal.aborted) throw new Error('cancelled');
    } finally { t.done(); }
  }
  const err = new Error(tried.length ? 'no server replied – ' + tried.join('; ') : 'Overpass unavailable');
  err.cause = lastErr; throw err;
}

/** Parse a milepost position. Returns {miles, unit:'mi'|'km'|'?'} or null. */
function parseMilepostPosition(tags) {
  const frac = (w, n, d) => +w + (n && d ? +n / +d : 0);
  let m;
  // Names such as "6 3/4 Milepost" / "12 MP"
  const label = String(tags.name || tags.ref || tags.description || '').trim();
  if ((m = label.match(/^(\d+)(?:\s+(\d)\/(\d))?\s*(?:mile\s*post|milepost|mp|miles?)\b/i))) return { miles: frac(m[1], m[2], m[3]), unit: 'mi' };
  if ((m = label.match(/^(\d+(?:[.,]\d+)?)\s*km$/i)) && !tags['railway:position']) return { value: +m[1].replace(',', '.'), miles: null, unit: 'km' };
  const raw = tags['railway:position:exact'] || tags['railway:position'] || tags['distance'] || '';
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // "12m 34ch", "12 m 34 ch", "12mi 34ch"
  if ((m = s.match(/^(\d+)\s*(?:m|mi|mls?|miles?)\s*(\d+(?:\.\d+)?)\s*(?:c|ch|chains?)$/))) return { miles: +m[1] + +m[2] / CHAINS_PER_MILE, unit: 'mi' };
  // "mi:12.25", "mi:12 1/4", "12.25 mi"
  if ((m = s.match(/^(?:mi|mile|miles):\s*(\d+(?:[.,]\d+)?)(?:\s+(\d)\/(\d))?$/))) return { miles: frac(m[1].replace(',', '.'), m[2], m[3]), unit: 'mi' };
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:mi|miles?)$/))) return { miles: +m[1].replace(',', '.'), unit: 'mi' };
  if ((m = s.match(/^(\d+)\s+(\d)\/(\d)$/))) return { value: frac(m[1], m[2], m[3]), miles: null, unit: '?' };
  if ((m = s.match(/^(?:km:)?\s*(\d+(?:[.,]\d+)?)\s*(km)?$/))) {
    // OSM's default unit is km, but UK mappers often enter miles without the "mi:" prefix – resolved later from spacing.
    return { value: +m[1].replace(',', '.'), miles: null, unit: (s.includes('km') ? 'km' : '?') };
  }
  return null;
}
function elrFrom(tags) {
  for (const k of ['ref:elr', 'railway:ref:elr', 'elr', 'ELR', 'railway:elr', 'railway:ref', 'ref']) {
    const v = tags[k]; if (v && ELR_RE.test(String(v).trim().toUpperCase())) return String(v).trim().toUpperCase();
  }
  return '';
}

// Local flat projection (metres) around a reference latitude – fine over a few km.
function projector(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  return (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky });
}
function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  const t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p.x - (a.x + tc * dx), p.y - (a.y + tc * dy)), t, len: Math.sqrt(L2) };
}

/** Pure analysis of an Overpass reply – exported for testing. */
function analyseOverpass(json, lat, lon) {
  const P = projector(lat, lon); const me = { x: 0, y: 0 };
  const els = (json && json.elements) || [];
  // ---- lines (ELR / track ID candidates)
  const lines = [];
  for (const w of els.filter(e => e.type === 'way' && e.geometry && e.geometry.length)) {
    const t = w.tags || {}; const pts = w.geometry.filter(g => g && Number.isFinite(g.lat)).map(g => P(g.lat, g.lon));
    let best = Infinity; for (let i = 1; i < pts.length; i++) best = Math.min(best, pointSegDist(me, pts[i - 1], pts[i]).d);
    if (pts.length === 1) best = Math.hypot(pts[0].x, pts[0].y);
    lines.push({ elr: elrFrom(t), name: t.name || '', trackRef: t['railway:track_ref'] || '', usage: t.usage || '', railway: t.railway, distM: Math.round(best) });
  }
  lines.sort((a, b) => a.distM - b.distM);
  const elrMap = new Map();
  for (const l of lines) {
    const key = l.elr || ('?' + l.name);
    if (!elrMap.has(key)) elrMap.set(key, { elr: l.elr, name: l.name, distM: l.distM, tracks: [] });
    const c = elrMap.get(key); if (l.trackRef && !c.tracks.some(t => t.ref === l.trackRef)) c.tracks.push({ ref: l.trackRef, distM: l.distM });
  }
  const elrCandidates = Array.from(elrMap.values()).filter(c => c.elr || c.name).slice(0, 4);
  elrCandidates.forEach(c => c.tracks.sort((a, b) => a.distM - b.distM));
  const nearestElr = (elrCandidates.find(c => c.elr) || {}).elr || '';

  // ---- mileposts
  let posts = els.filter(e => e.type === 'node' && Number.isFinite(e.lat)).map(n => {
    const t = n.tags || {}; const pos = parseMilepostPosition(t); const p = P(n.lat, n.lon);
    return pos ? { lat: n.lat, lon: n.lon, x: p.x, y: p.y, pos, elr: elrFrom(t), raw: t['railway:position'] || t['railway:position:exact'] || t.distance || t.name || t.ref || '', distM: Math.round(Math.hypot(p.x, p.y)) } : null;
  }).filter(Boolean);
  const totalPosts = els.filter(e => e.type === 'node').length;
  // Prefer posts on the nearest line's ELR when both are tagged.
  if (nearestElr && posts.some(p => p.elr === nearestElr)) posts = posts.filter(p => !p.elr || p.elr === nearestElr);
  posts.sort((a, b) => a.distM - b.distM);
  posts = posts.slice(0, 12);

  // Resolve unknown units using spacing between pairs: whichever of miles/km best matches the ground distance.
  const val = (p, unit) => p.pos.unit === 'mi' ? p.pos.miles : p.pos.unit === 'km' ? p.pos.value / 1.609344 : unit === 'mi' ? p.pos.value : p.pos.value / 1.609344;
  let unknownUnit = 'mi';
  const unk = posts.filter(p => p.pos.unit === '?');
  if (unk.length >= 2) {
    let errMi = 0, errKm = 0, n = 0;
    for (let i = 0; i < unk.length; i++) for (let j = i + 1; j < unk.length; j++) {
      const g = Math.hypot(unk[i].x - unk[j].x, unk[i].y - unk[j].y); const dv = Math.abs(unk[i].pos.value - unk[j].pos.value);
      if (!dv || g < 50) continue; n++;
      errMi += Math.abs(Math.log((dv * METRES_PER_MILE) / g)); errKm += Math.abs(Math.log((dv * 1000) / g));
    }
    if (n && errKm < errMi) unknownUnit = 'km';
  }
  posts.forEach(p => { p.miles = val(p, unknownUnit); });

  // Pair search: interpolate between two posts, preferring a pair that brackets the point.
  let best = null;
  for (let i = 0; i < posts.length; i++) for (let j = i + 1; j < posts.length; j++) {
    const a = posts[i], b = posts[j];
    if (a.elr && b.elr && a.elr !== b.elr) continue;
    const dMiles = b.miles - a.miles; if (!dMiles || Math.abs(dMiles) > 3) continue;
    const s = pointSegDist(me, a, b); if (s.len < 50) continue;
    const ratio = (Math.abs(dMiles) * METRES_PER_MILE) / s.len;
    if (ratio < 0.6 || ratio > 1.6) continue; // posts don't look like the same line
    const bracket = s.t >= 0 && s.t <= 1;
    const perp = Math.abs(((me.x - a.x) * (b.y - a.y) - (me.y - a.y) * (b.x - a.x)) / s.len);
    if (perp > 400) continue;
    const score = (bracket ? 0 : 5000 + Math.abs(s.t < 0 ? s.t : s.t - 1) * s.len * 3) + perp * 2 + s.len * 0.3 + Math.abs(Math.log(ratio)) * 500;
    if (!best || score < best.score) best = { a, b, t: s.t, bracket, perp, ratio, score };
  }
  let estimate = null;
  if (best) {
    const decMiles = best.a.miles + best.t * (best.b.miles - best.a.miles);
    if (decMiles >= 0) {
      const mc = milesToMC(decMiles);
      const confidence = best.bracket && best.perp < 60 && Math.abs(Math.log(best.ratio)) < 0.2 ? 'fair' : 'low';
      estimate = { elr: best.a.elr || best.b.elr || nearestElr, miles: mc.miles, chains: mc.chains, decMiles: round(decMiles, 4), confidence, bracketed: best.bracket, offsetM: Math.round(best.perp),
        from: [best.a, best.b].map(p => ({ miles: round(p.miles, 3), raw: p.raw, elr: p.elr, distM: p.distM })), unitAssumed: posts.some(p => p.pos.unit === '?') ? unknownUnit : null };
    }
  }
  const nearestPost = posts[0] ? { miles: round(posts[0].miles, 3), raw: posts[0].raw, elr: posts[0].elr, distM: posts[0].distM } : null;
  return { elrCandidates, nearestElr, milepostsFound: totalPosts, milepostsUsable: posts.length, nearestPost, estimate };
}

async function estimateChainage(lat, lon, signal) {
  const { json, endpoint } = await fetchOverpass(overpassQuery(lat, lon), signal);
  const out = analyseOverpass(json, lat, lon);
  out.endpoint = endpoint;
  return out;
}
