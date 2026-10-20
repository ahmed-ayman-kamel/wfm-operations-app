/**
 * Dash_Adherence.gs — NEW FILE. Server side of the Adherence dashboard.
 * -----------------------------------------------------------------------------
 * Reads "Raw Data" A:W of the Adherence Data spreadsheet (A:O from NICE, P:W from the formulas)
 * and returns ONE compact columnar payload: one fact per NICE row (date × agent × activity) with its
 * minutes. The page does every filter, grouping and ratio in the browser, so a click never calls the server.
 *
 * Every figure is a ratio of sums, exactly like the workbook's pivot tables:
 *   Adherence %      = Σ Min. in Adherence ÷ Σ Scheduled Time Min      (pivot calculated field)
 *   Conformance %    = Σ Actual minutes ÷ Σ Scheduled minutes            (extra, from the same rows)
 * Rows whose Queue is blank / "Not in Database" are left out of the VRI/Operator views (the pivots hide
 * them); they are listed in Data health.
 *
 * Public (guarded by requireDashboardAccess_('adherence')):
 *   getAdherenceDashboardData()  -> { ok, stamp, cached, payload }
 *   getAdherenceDashboardStamp() -> { ok, stamp }   (cheap; the page polls it)
 * Depends on Dashboards.gs and Adherence.gs. No ScriptApp, no new OAuth scope.
 */

var ADHD = {
  CACHE_KEY: 'ADHD_FACTS_V2',                       // V2 (2026-10-09): actual minutes read correctly from real Sheets
  CACHE_TTL: 6 * 60 * 60,
  CACHE_CHUNK: 90000,
  READ_BLOCK: 20000,
  TARGET: 0.96          // adherence target (owner, 2026-10-09): cells, bars and the summary are judged against it; null = no target
};

function getAdherenceDashboardData() {
  requireDashboardAccess_('adherence');
  var ss = ADH_ss_(), stamp = ADHD_stamp_(ss);
  var hit = ADHD_cacheGet_(stamp);
  var payload = hit || ADHD_build_(ss, stamp);
  if (!hit) ADHD_cachePut_(stamp, payload);
  payload.today = ADH_today_();
  payload.target = ADHD.TARGET;                                       // set per request, so a new target never waits for the cache
  payload.canRun = ADH_canRun_(dashRole_());
  payload.plan = ADH_plan_(payload.today);
  return { ok: true, stamp: stamp, cached: !!hit, payload: payload };
}

function getAdherenceDashboardStamp() {
  requireDashboardAccess_('adherence');
  return { ok: true, stamp: ADHD_stamp_(ADH_ss_()) };
}

/** Last load time + lookup checksum (changes when a Database edit changes a looked-up value). */
function ADHD_stamp_(ss) {
  var c = ss.getSheetByName(ADH.CONTROL);
  if (!c) return 'none';
  var v = c.getRange('B2:B9').getValues(), t = v[0][0];
  return String(t instanceof Date ? t.getTime() : (t || 'none')) + '|' + String(v[7][0]);
}

function ADHD_build_(ss, stamp) {
  var sh = ADH_sheet_(ss), last = ADH_lastRow_(sh), rows = [];
  for (var r = 2; r <= last; r += ADHD.READ_BLOCK) {
    var n = Math.min(ADHD.READ_BLOCK, last - r + 1);
    var block = sh.getRange(r, 1, n, ADH.TOTAL_COLS).getValues();
    for (var i = 0; i < block.length; i++) rows.push(block[i]);
  }
  var c = ss.getSheetByName(ADH.CONTROL), ctl = c ? c.getRange('B2:B8').getValues().map(function (x) { return x[0]; }) : [];
  var db = ADH_dbStatus_(ss, false);
  var log = [];
  try {
    var l = ss.getSheetByName(ADH.LOG), ll = l ? l.getLastRow() : 0;
    if (ll >= 2) {
      var n2 = Math.min(8, ll - 1);
      log = l.getRange(ll - n2 + 1, 1, n2, 11).getValues().reverse().map(function (x) {
        return [x[0] instanceof Date ? x[0].getTime() : String(x[0]), String(x[1]), ADH_ymdOf_(x[2]) || String(x[2]), ADH_ymdOf_(x[3]) || String(x[3]), x[5], x[9], String(x[10]).slice(0, 300)];
      });
    }
  } catch (ignore) {}
  var p = ADHD_aggregate_(rows);
  p.lastLoad = ctl[0] instanceof Date ? ctl[0].getTime() : null;
  p.lastBy = String(ctl[6] || '');
  p.lastStatus = String(ctl[2] || '');
  p.db = { ok: db.ok, message: db.message, agents: db.rows || 0 };
  p.log = log;
  p.stamp = stamp;
  p.target = ADHD.TARGET;
  return p;
}

/**
 * Pure: Raw Data rows A:W → payload.
 * Row: 0 Date 1 EntityID 2 Entity 3 AgentID 4 AgentName 5 Activity 6 Sched(day frac) 7 Actual(day frac) 8 In 9 Out
 *      10 %Adh 11 +/-Conf 12 %Conf 13 %TotSched 14 %TotActual 15 NameOnCommunity 16 Language 17 LG 18 Supervisor
 *      19 Queue 20 SchedMin 21 Platform 22 SDACMs
 */
function ADHD_aggregate_(rows) {
  var num = function (v) { return typeof v === 'number' ? v : (v === '' || v === null || v === undefined || isNaN(Number(v)) ? 0 : Number(v)); };
  var str = function (v) { v = String(v === null || v === undefined ? '' : v).trim(); return v === '' || v === '0' ? '(blank)' : v; };
  var dIdx = {}, dates = [], aIdx = {}, agents = [], tIdx = {}, acts = [];
  var F = { d: [], a: [], t: [], sm: [], am: [], i: [], o: [], c: [] };
  var dayRows = {}, unmapped = {}, mism = 0, memo = {};
  rows.forEach(function (r) {
    if (r[3] === '' || r[3] === null || r[3] === undefined) return;
    var day = '';
    if (r[0] instanceof Date) { var k = r[0].getTime(); day = memo[k] || (memo[k] = ADH_ymdOf_(r[0])); }
    else day = ADH_ymdOf_(r[0]);
    if (!day) return;
    if (!dIdx.hasOwnProperty(day)) { dIdx[day] = dates.length; dates.push(day); }
    var id = String(r[3]).trim();
    if (!aIdx.hasOwnProperty(id)) {
      var mapped = String(r[19]) !== ADH.MISSING && str(r[19]) !== '(blank)';
      aIdx[id] = agents.length;
      agents.push({ id: id, nice: String(r[4] || ''), name: mapped ? str(r[15]) : String(r[4] || id), lang: str(r[16]), lg: str(r[17]), sup: str(r[18]),
                    q: mapped ? str(r[19]) : '(blank)', plat: str(r[21]), sd: str(r[22]), mapped: mapped });
    }
    var act = String(r[5] || '(blank)').trim() || '(blank)';
    if (!tIdx.hasOwnProperty(act)) { tIdx[act] = acts.length; acts.push(act); }
    // G/H are durations: real Sheets returns a duration cell as a Date (1899-12-30 + time), not a number. Minutes then come
    // from U (Scheduled Time Min) and from NICE's own "Percent in Conformance" (M = actual ÷ scheduled), which is exact to the minute.
    var inn = num(r[8]), out = num(r[9]);
    var sm = typeof r[20] === 'number' ? r[20] : (r[6] instanceof Date ? inn + out : Math.round(num(r[6]) * 1440));
    var am = r[7] instanceof Date || r[7] === '' || r[7] === null ? Math.round(sm * num(r[12])) : Math.round(num(r[7]) * 1440);
    F.d.push(dIdx[day]); F.a.push(aIdx[id]); F.t.push(tIdx[act]); F.sm.push(sm); F.am.push(am); F.i.push(inn); F.o.push(out); F.c.push(num(r[11]));
    dayRows[day] = (dayRows[day] || 0) + 1;
    if (!agents[aIdx[id]].mapped) { unmapped[id] = unmapped[id] || { id: id, name: String(r[4] || ''), rows: 0 }; unmapped[id].rows++; }
    if (sm !== inn + out) mism++;
  });
  // dates sorted; remap fact day indexes so d is the index into the sorted list
  var sorted = dates.slice().sort(), remap = dates.map(function (d) { return sorted.indexOf(d); });
  F.d = F.d.map(function (x) { return remap[x]; });
  var missingDays = [];
  if (sorted.length > 1) for (var d = sorted[0]; d < sorted[sorted.length - 1]; d = ADH_addDays_(d, 1)) if (!dayRows[d]) missingDays.push(d);
  return {
    version: 1, dates: sorted, agents: agents, acts: acts, f: F,
    health: { rows: F.d.length, days: sorted.map(function (x) { return [x, dayRows[x]]; }), missingDays: missingDays,
              unmapped: Object.keys(unmapped).map(function (k) { return unmapped[k]; }), minuteMismatch: mism }
  };
}

/* ============================== CACHE (gzip + base64 chunks; same pattern as Dash_Voyce.gs) ============================== */
function ADHD_cacheGet_(stamp) {
  try {
    var c = CacheService.getScriptCache(), meta = c.get(ADHD.CACHE_KEY + '_META');
    if (!meta) return null;
    meta = JSON.parse(meta);
    if (meta.stamp !== stamp) return null;
    var keys = []; for (var i = 0; i < meta.n; i++) keys.push(ADHD.CACHE_KEY + '_' + i);
    var got = c.getAll(keys), b64 = '';
    for (var j = 0; j < meta.n; j++) { var part = got[ADHD.CACHE_KEY + '_' + j]; if (part === undefined || part === null) return null; b64 += part; }
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString());
  } catch (e) { return null; }
}
function ADHD_cachePut_(stamp, payload) {
  try {
    var c = CacheService.getScriptCache();
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(payload), 'application/json')).getBytes());
    var n = Math.ceil(b64.length / ADHD.CACHE_CHUNK), put = {};
    if (n > 40) return;
    for (var i = 0; i < n; i++) put[ADHD.CACHE_KEY + '_' + i] = b64.slice(i * ADHD.CACHE_CHUNK, (i + 1) * ADHD.CACHE_CHUNK);
    put[ADHD.CACHE_KEY + '_META'] = JSON.stringify({ stamp: stamp, n: n });
    c.putAll(put, ADHD.CACHE_TTL);
  } catch (e) { /* optimisation only */ }
}
/** Called at the end of a save so the next visitor never waits. */
function ADHD_warm_() {
  var ss = ADH_ss_(), stamp = ADHD_stamp_(ss);
  if (!ADHD_cacheGet_(stamp)) ADHD_cachePut_(stamp, ADHD_build_(ss, stamp));
}
