/**
 * Dash_Voyce.gs — NEW FILE (does not change any existing file). Replaces the earlier draft "Dashboard.gs".
 * -----------------------------------------------------------------------------
 * Server side of the Voyce Performance dashboard. Reads the "Voyce Online Hours" sheet
 * (filled by VoyceOnlineHours.gs) and the roster ("SD Dis", read only), and returns ONE compact,
 * columnar payload of agent x day facts. The page (Dashboard_HTML.html) does every filter, grouping
 * and KPI calculation in the browser, so a click never makes a server call.
 *
 * Every KPI is a ratio of sums, exactly as in the workbook, so the server only adds up:
 *   paidMin / paidSec   Σ Minutes / Σ Seconds                  (online rows)
 *   talkMin / talkSec   Σ ServiceMinutes / Σ ServiceSeconds    (online rows)
 *   assigned            call rows (Transaction Id present)
 *   accepted            call rows with an Accepted Code
 *   short               Σ Short Calls (all call rows, as the workbook; shortAcc = only accepted rows)
 *   offline             online rows with an OffReason
 *   other               OffReason = bare "Other:"            (TRIM, as the workbook)
 *   otherMissing        OffReason = "Other: Missing Calls"
 *
 * Public entry points (both guarded):
 *   getVoyceDashboardData()    -> { ok, stamp, cached, payload }
 *   getVoyceDashboardStamp()   -> { ok, stamp }     (cheap; the page polls it to know when to reload)
 *
 * Access: the roles listed for 'voyce' in Dashboards.gs (Manager, Admin, Operations), checked on the
 * server by requireDashboardAccess_('voyce'). Depends on Dashboards.gs and on VoyceOnlineHours.gs
 * (VOH_sheet_, VOH_ss_, VOH_lastDataRow_, VOH_day_ ...).
 *
 * Offline codes are kept per exact OffReason text (as the workbook's breakdown sheets show them).
 * Like an Excel pivot, texts that differ only in upper/lower case are one item (first spelling shown).
 * No ScriptApp, no new OAuth scope.
 */

var VOHD = {
  CACHE_KEY: 'VOHD_FACTS',
  CACHE_TTL: 6 * 60 * 60,           // seconds (CacheService maximum)
  CACHE_CHUNK: 90000,               // characters per cache entry (limit is 100 KB)
  READ_BLOCK: 20000,                // rows read from the sheet at a time
  COLS: 11,                         // A:K of 'Voyce Online Hours' (AA "Ign" is read separately)
  TARGETS: { productivity: 0.40, csr: 0.98, missing: 0.01, other: 0 }   // from the workbook colour rules
};

/* ============================== PUBLIC ============================== */
function getVoyceDashboardData() {
  VOHD_requireAccess_();
  var stamp = VOHD_stamp_(), ign = VOHD_ign_(), key = VOHD_key_(stamp, ign);
  var hit = VOHD_cacheGet_(key);
  if (hit) return { ok: true, stamp: stamp, ign: ign, cached: true, payload: VOHD_freshToday_(hit) };
  var payload = VOHD_build_(stamp);
  VOHD_cachePut_(key, payload);
  return { ok: true, stamp: stamp, ign: ign, cached: false, payload: VOHD_freshToday_(payload) };
}

/** A cached payload can be from before midnight: "today" is always set at the moment of the request. */
function VOHD_freshToday_(p) {
  p.today = VOH_today_();
  p.health.partialDay = p.dates.indexOf(p.today) >= 0 ? p.today : '';
  return p;
}

function getVoyceDashboardStamp() {
  VOHD_requireAccess_();
  return { ok: true, stamp: VOHD_stamp_(), ign: VOHD_ign_() };
}

/* ============================== ACCESS ============================== */
function VOHD_requireAccess_() { requireDashboardAccess_('voyce'); }

/* ============================== BUILD ============================== */
function VOHD_stamp_() {
  var ss = VOH_ss_(), c = ss.getSheetByName(VOH.CONTROL), v = c ? c.getRange('B2').getValue() : '';
  return String(v instanceof Date ? v.getTime() : v || 'none');
}

/** Changes whenever someone adds, removes or moves a hand-typed 1 in the Ign column (_Control B8:B9, formulas). '' when not set up yet. */
function VOHD_ign_() {
  try {
    var c = VOH_ss_().getSheetByName(VOH.CONTROL);
    if (!c) return '';
    var v = c.getRange('B8:B9').getValues();
    return (v[0][0] === '' && v[1][0] === '') ? '' : String(v[0][0]) + '.' + String(v[1][0]);
  } catch (e) { return ''; }
}
function VOHD_key_(stamp, ign) { return ign ? stamp + '|' + ign : stamp; }

/** True for a hand-typed 1 in the Ign column (number or text). Blank, 0 and anything else keep the row. */
/**
 * Roster rows (header row first) -> rows in the original SD Dis layout (13 columns) that VOHD_aggregate_ reads:
 * 0 Interpreter name, 4 Language Group, 6 Status, 7 FG ID, 8 Voyce ID, 9 Classification, 10 Team leader, 11 ACM, 12 Seat Language.
 * Columns are found by their header, so both layouts work: the old hand-pasted SD Dis, and the IMPORTRANGE of the
 * Roster Database month tab (ID = FG ID, Supervisor = Team leader, Manager = ACM; owner decision 2026-10-10).
 * A header that is not found falls back to the old position.
 */
function VOHD_normRoster_(values) {
  if (!values || values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim().toLowerCase(); });
  var find = function (names, fallback) {
    for (var i = 0; i < names.length; i++) { var c = head.indexOf(names[i]); if (c !== -1) return c; }
    return fallback;
  };
  var map = [
    find(['interpreter name'], 0), -1, -1, -1,
    find(['language group'], 4), -1,
    find(['status'], 6),
    find(['fg id', 'id'], 7),
    find(['voyce id'], 8),
    find(['classification'], 9),
    find(['team leader', 'supervisor'], 10),
    find(['acm', 'manager'], 11),
    find(['seat language'], 12)
  ];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var src = values[r], row = [];
    for (var k = 0; k < 13; k++) { var c = map[k]; row.push(c >= 0 && c < src.length ? src[c] : ''); }
    out.push(row);
  }
  return out;
}

function VOHD_isIgn_(v) { return v === 1 || (typeof v === 'string' && v.trim() === '1'); }

function VOHD_build_(stamp) {
  var sh = VOH_sheet_(), ss = VOH_ss_(), last = VOH_lastDataRow_(sh), rows = [];
  for (var r = 2; r <= last; r += VOHD.READ_BLOCK) {
    var n = Math.min(VOHD.READ_BLOCK, last - r + 1);
    var block = sh.getRange(r, 1, n, VOHD.COLS).getValues();
    for (var i = 0; i < block.length; i++) rows.push(block[i]);
  }
  var rosterSheet = ss.getSheetByName(VOH.ROSTER), roster = [];
  if (rosterSheet && rosterSheet.getLastRow() >= 2) {
    var rc = Math.min(40, rosterSheet.getLastColumn());
    roster = VOHD_normRoster_(rosterSheet.getRange(1, 1, rosterSheet.getLastRow(), rc).getValues());
  }
  var ign = [];                                                          // AA "Ign", typed by hand (blank or 1), one value per row read above
  if (sh.getMaxColumns() >= VOH.IGN_COL && last >= 2) {
    for (var q = 2; q <= last; q += VOHD.READ_BLOCK) {
      var m = Math.min(VOHD.READ_BLOCK, last - q + 1);
      var col = sh.getRange(q, VOH.IGN_COL, m, 1).getValues();
      for (var z = 0; z < col.length; z++) ign.push(col[z][0]);
    }
  }
  var payload = VOHD_aggregate_(rows, roster, VOH_today_(), ign);
  payload.lastLoad = stamp;
  return payload;
}

/**
 * Pure (no Sheets calls): sheet rows A:K + roster rows A:M (+ the Ign column AA, one raw value per row) -> columnar payload.
 * A row whose Ign value is 1 is left out of everything (it is only counted in health.ignored).
 * Row layout: 0 ProviderId 1 Name 2 Start/Request Time 3 OffReason 4 Minutes 5 Seconds 6 ServiceMinutes
 *             7 ServiceSeconds 8 Accepted Codes 9 Transaction Id 10 Short Calls
 */
function VOHD_aggregate_(rows, roster, today, ign) {
  // r.c indexes payload.reasons (exact OffReason text); the page derives the category (text before ':').
  var num = function (v) { return typeof v === 'number' ? v : (v === '' || v === null || v === undefined || isNaN(Number(v)) ? 0 : Number(v)); };
  var memo = {}, dayOf = function (d) {                                // day in New York; one formatDate per clock hour
    if (!(d instanceof Date)) return '';
    var k = Math.floor(d.getTime() / 3600000);
    return memo[k] || (memo[k] = VOH_day_(d));
  };

  // roster by Voyce ID (first match wins, as XLOOKUP)
  var rost = {};
  roster.forEach(function (r) {
    var id = String(r[8] === null || r[8] === undefined ? '' : r[8]).trim();
    if (id && !rost.hasOwnProperty(id)) rost[id] = r;
  });
  var canon = {};                                                       // pivot-like: one item per text, ignoring case
  var blank = function (v) {
    v = String(v === null || v === undefined ? '' : v).trim();
    if (v === '' || v === '0') return '(blank)';
    var k = v.toLowerCase();
    return canon.hasOwnProperty(k) ? canon[k] : (canon[k] = v);
  };

  var acc = {}, agentIdx = {}, agents = [], unmapped = {}, reasonIdx = {}, reasons = [], reasonAcc = {};
  var nOnline = 0, nCalls = 0, dayRows = {};
  var ignored = { rows: 0, online: 0, calls: 0, bad: 0, badRows: [] };
  rows.forEach(function (r, ri) {
    var id = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim();
    if (!id) return;
    var iv = ign ? ign[ri] : '';
    if (iv !== '' && iv !== null && iv !== undefined) {
      if (VOHD_isIgn_(iv)) {                                              // hand-typed 1: leave the row out of everything
        ignored.rows++;
        if (r[9] === '' || r[9] === null || r[9] === undefined) ignored.online++; else ignored.calls++;
        return;
      }
      if (!(iv === 0 || String(iv).trim() === '0')) { ignored.bad++; if (ignored.badRows.length < 10) ignored.badRows.push(ri + 2); }   // typed something other than blank or 1
    }
    var day = dayOf(r[2]);
    if (!day) return;
    var isCall = !(r[9] === '' || r[9] === null || r[9] === undefined);
    if (!agentIdx.hasOwnProperty(id)) {
      var ro = rost[id];
      agentIdx[id] = agents.length;
      agents.push(ro ? { id: id, name: blank(ro[0]), acm: blank(ro[11]), tl: blank(ro[10]), lang: blank(ro[12]), lg: blank(ro[4]),
                          fg: blank(ro[7]), status: blank(ro[6]), cls: blank(ro[9]), mapped: true }
                     : { id: id, name: String(r[1] || id), acm: 'Not in roster', tl: 'Not in roster', lang: 'Not in roster', lg: 'Not in roster',
                          fg: 'Not in roster', status: 'Not in roster', cls: 'Not in roster', mapped: false });
    }
    var a = agentIdx[id], key = day + '|' + a, f = acc[key];
    if (!f) f = acc[key] = { day: day, a: a, pm: 0, ps: 0, tm: 0, ts: 0, asg: 0, acc: 0, sh: 0, sa: 0, off: 0, oth: 0, om: 0 };
    var dr = dayRows[day] || (dayRows[day] = { online: 0, calls: 0 });
    if (isCall) {
      nCalls++; dr.calls++;
      f.asg++;
      var accepted = !(r[8] === '' || r[8] === null || r[8] === undefined);
      if (accepted) f.acc++;
      var s = num(r[10]);
      f.sh += s;
      if (accepted) f.sa += s;
    } else {
      nOnline++; dr.online++;
      f.pm += num(r[4]); f.ps += num(r[5]); f.tm += num(r[6]); f.ts += num(r[7]);
      var reason = String(r[3] === null || r[3] === undefined ? '' : r[3]);
      if (reason !== '') {
        f.off++;
        var t = reason.trim(), low = t.toLowerCase();
        if (low === 'other:') f.oth++;                                    // workbook: OffReason = "Other: " (Excel ignores case)
        if (low === 'other: missing calls') f.om++;
        var rkey = reason.toLowerCase();
        if (!reasonIdx.hasOwnProperty(rkey)) { reasonIdx[rkey] = reasons.length; reasons.push(reason); }
        var rk = key + '|' + reasonIdx[rkey];
        reasonAcc[rk] = (reasonAcc[rk] || { day: day, a: a, c: reasonIdx[rkey], n: 0 });
        reasonAcc[rk].n++;
      }
    }
    if (!rost[id]) { unmapped[id] = unmapped[id] || { id: id, name: String(r[1] || ''), rows: 0 }; unmapped[id].rows++; }
  });

  var dates = Object.keys(dayRows).sort(), dIdx = {};
  dates.forEach(function (d, i) { dIdx[d] = i; });
  var keys = Object.keys(acc).sort(), F = { d: [], a: [], pm: [], ps: [], tm: [], ts: [], asg: [], acc: [], sh: [], sa: [], off: [], oth: [], om: [] };
  keys.forEach(function (k) {
    var f = acc[k];
    F.d.push(dIdx[f.day]); F.a.push(f.a); F.pm.push(f.pm); F.ps.push(f.ps); F.tm.push(f.tm); F.ts.push(f.ts);
    F.asg.push(f.asg); F.acc.push(f.acc); F.sh.push(f.sh); F.sa.push(f.sa); F.off.push(f.off); F.oth.push(f.oth); F.om.push(f.om);
  });
  var rk2 = Object.keys(reasonAcc).sort(), R = { d: [], a: [], c: [], n: [] };
  rk2.forEach(function (k) { var x = reasonAcc[k]; R.d.push(dIdx[x.day]); R.a.push(x.a); R.c.push(x.c); R.n.push(x.n); });

  // days with no rows between the first and the last loaded day (checks for gaps in the loading)
  var missingDays = [];
  if (dates.length > 1) {
    for (var d = dates[0]; d < dates[dates.length - 1]; d = VOH_addDays_(d, 1)) if (!dayRows[d]) missingDays.push(d);
  }
  var days = dates.map(function (d) { return [d, dayRows[d].online, dayRows[d].calls]; });
  return {
    version: 2, today: today, dates: dates, agents: agents, reasons: reasons, f: F, r: R,
    targets: VOHD.TARGETS,
    health: { rows: nOnline + nCalls, online: nOnline, calls: nCalls, days: days, missingDays: missingDays,
              partialDay: dayRows[today] ? today : '', ignored: ignored, unmapped: Object.keys(unmapped).map(function (k) { return unmapped[k]; }) }
  };
}

/* ============================== CACHE ============================== */
/** Payload as gzip + base64 in chunks. Key = stamp of the last load, so every new load makes a fresh payload. */
function VOHD_cacheGet_(stamp) {
  try {
    var c = CacheService.getScriptCache(), meta = c.get(VOHD.CACHE_KEY + '_META');
    if (!meta) return null;
    meta = JSON.parse(meta);
    if (meta.stamp !== stamp) return null;
    var keys = [];
    for (var i = 0; i < meta.n; i++) keys.push(VOHD.CACHE_KEY + '_' + i);
    var got = c.getAll(keys), b64 = '';
    for (var j = 0; j < meta.n; j++) { var part = got[VOHD.CACHE_KEY + '_' + j]; if (part === undefined || part === null) return null; b64 += part; }
    var blob = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip'));
    return JSON.parse(blob.getDataAsString());
  } catch (e) { return null; }
}

function VOHD_cachePut_(stamp, payload) {
  try {
    var c = CacheService.getScriptCache();
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(payload), 'application/json')).getBytes());
    var n = Math.ceil(b64.length / VOHD.CACHE_CHUNK), put = {};
    if (n > 40) return;                                                  // very large: skip the cache, never fail the request
    for (var i = 0; i < n; i++) put[VOHD.CACHE_KEY + '_' + i] = b64.slice(i * VOHD.CACHE_CHUNK, (i + 1) * VOHD.CACHE_CHUNK);
    put[VOHD.CACHE_KEY + '_META'] = JSON.stringify({ stamp: stamp, n: n });
    c.putAll(put, VOHD.CACHE_TTL);
  } catch (e) { /* the cache is an optimisation only */ }
}

/** Optional: call at the end of a load (inside try/catch) so the next visitor never waits. */
function VOHD_warm_() {
  var stamp = VOHD_stamp_(), key = VOHD_key_(stamp, VOHD_ign_());
  if (!VOHD_cacheGet_(key)) VOHD_cachePut_(key, VOHD_build_(stamp));
}