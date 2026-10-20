/**
 * Dash_Mvcc.gs — NEW FILE. Server side of the MVCC Performance dashboard.
 * -----------------------------------------------------------------------------
 * Reads "MVCC data" A:Z of the MVCC Data spreadsheet (A:K from Sisense, B and L:Z from the row-1 formulas)
 * and returns ONE compact columnar payload: one fact per MVCC data row (date × agent) with its volumes. The page
 * does every filter, grouping and ratio in the browser, so a click never calls the server.
 *
 * Every figure is a ratio of sums, exactly like the workbook's pivot tables (calculated fields):
 *   Productivity % = Σ Talk time ÷ Σ Paid hour        CSR%          = Σ Accepted ÷ Σ Assigned
 *   Abn %          = Σ Abandond  ÷ Σ Assigned         Short calls % = Σ Short calls ÷ Σ Assigned
 * Targets come from the workbook's conditional formats: Productivity ≥ 40%, CSR% ≥ 98%, Abn % < 2%, Short calls % < 2%.
 *
 * Public (guarded by requireDashboardAccess_('mvcc')):
 *   getMvccDashboardData()  -> { ok, stamp, cached, payload }
 *   getMvccDashboardStamp() -> { ok, stamp }   (cheap; the page polls it)
 * Depends on Dashboards.gs and Mvcc.gs. No ScriptApp, no new OAuth scope.
 */

var MVD = {
  CACHE_KEY: 'MVD_FACTS_V1',
  CACHE_TTL: 6 * 60 * 60,
  CACHE_CHUNK: 90000,
  TARGETS: { prod: 0.40, csr: 0.98, abn: 0.02, scp: 0.02 }     // workbook conditional formats (owner's report, Oct-26)
};

function getMvccDashboardData() {
  requireDashboardAccess_('mvcc');
  var ss = MV_ss_(), stamp = MVD_stamp_(ss);
  var hit = MVD_cacheGet_(stamp);
  var payload = hit || MVD_build_(ss, stamp);
  if (!hit) MVD_cachePut_(stamp, payload);
  payload.today = MV_today_();
  payload.targets = MVD.TARGETS;                                      // set per request, so a new target never waits for the cache
  payload.canRun = MV_canRun_(dashRole_());
  payload.backfill = MV_backfillPlan_(payload.today);
  payload.paidPlan = MV_paidPlan_(payload.today);
  return { ok: true, stamp: stamp, cached: !!hit, payload: payload };
}

function getMvccDashboardStamp() {
  requireDashboardAccess_('mvcc');
  return { ok: true, stamp: MVD_stamp_(MV_ss_()) };
}

/** Last Sisense load + last Paid Hours load + lookup checksum (changes when a Database edit changes a looked-up value). */
function MVD_stamp_(ss) {
  var c = ss.getSheetByName(MVCC.CONTROL);
  if (!c) return 'none';
  var v = c.getRange('B2:B' + MVCC.CHECKSUM_ROW).getValues(), t = function (x) { return x instanceof Date ? x.getTime() : String(x || ''); };
  return t(v[0][0]) + '|' + t(v[7][0]) + '|' + String(v[MVCC.CHECKSUM_ROW - 2][0]);
}

function MVD_build_(ss, stamp) {
  var sh = ss.getSheetByName(MVCC.DATA), last = MV_lastRow_(sh, 1);
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, MVCC.DATA_TOTAL_COLS).getValues() : [];
  var p = MVD_aggregate_(rows);
  var c = ss.getSheetByName(MVCC.CONTROL), ctl = c ? c.getRange('B2:B12').getValues().map(function (x) { return x[0]; }) : [];
  var ms = function (x) { return x instanceof Date ? x.getTime() : null; };
  p.lastLoad = ms(ctl[0]); p.lastPeriod = String(ctl[1] || ''); p.lastStatus = String(ctl[2] || ''); p.lastBy = String(ctl[6] || '');
  p.lastPaid = ms(ctl[7]); p.paidPeriod = String(ctl[8] || ''); p.paidBy = String(ctl[10] || '');
  p.dedupe = MV_dedupeSetting_(ss);
  var db = MV_dbStatus_(ss, false);
  p.db = { ok: db.ok, message: db.message || '', agents: db.rows || 0 };
  p.paidDays = MVD_paidDays_(ss);
  p.flags = MVD_flags_(ss);
  p.log = MVD_log_(ss);
  p.stamp = stamp;
  return p;
}

/**
 * Pure: MVCC data rows A:Z → payload.
 * Row: 0 Date 1 Week 2 Vendor 3 Agent name 4 Assigned 5 Accepted 6 CSR 7 Timed Out 8 Cancelled 9 TO rate 10 Canc rate
 *      11 Abandond 12 Paid hour 13 Talk time 14 Short calls 15 THT 16 Nice ID 17 Interpreter ID 18 Interpreter Name
 *      19 TL 20 Seat 21 Langauge 22 LOB 23 Language Group 24 SDACMs 25 Email
 */
function MVD_aggregate_(rows) {
  var err = function (v) { return typeof v === 'string' && /^#(N\/A|REF|VALUE|DIV|NAME|NUM|ERROR)/i.test(v); };
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : (v === '' || v === null || v === undefined || err(v) || isNaN(Number(v)) ? 0 : Number(v)); };
  var str = function (v) { if (err(v)) return '(blank)'; v = String(v === null || v === undefined ? '' : v).trim(); return v === '' || v === '0' ? '(blank)' : v; };
  var dIdx = {}, dates = [], aIdx = {}, agents = [], memo = {};
  var F = { d: [], a: [], as: [], ac: [], ab: [], to: [], ca: [], ph: [], tt: [], sc: [], dup: [] };
  var seen = {}, dayRows = {}, lookupErr = {}, dups = 0;
  rows.forEach(function (r) {
    var name = String(r[3] === null || r[3] === undefined ? '' : r[3]).trim();
    if (!name) return;
    var day = '';
    if (r[0] instanceof Date) { var k = r[0].getTime(); day = memo[k] || (memo[k] = MV_ymdOf_(r[0])); } else day = MV_ymdOf_(r[0]);
    if (!day) return;
    if (!dIdx.hasOwnProperty(day)) { dIdx[day] = dates.length; dates.push(day); }
    var key = name.toLowerCase();
    if (!aIdx.hasOwnProperty(key)) {
      var lob = str(r[22]);
      aIdx[key] = agents.length;
      agents.push({ name: name, iname: str(r[18]), nice: str(r[17]), tl: str(r[19]), seat: str(r[20]), lang: str(r[21]),
                    lob: lob === 'operator' ? 'Operator' : lob, lg: str(r[23]), sd: str(r[24]), vendor: str(r[2]), email: str(r[25]) });
    }
    var a = aIdx[key], dk = day + '|' + a, isDup = seen[dk] ? 1 : 0;
    seen[dk] = 1; if (isDup) dups++;
    F.d.push(dIdx[day]); F.a.push(a);
    F.as.push(num(r[4])); F.ac.push(num(r[5])); F.to.push(num(r[7])); F.ca.push(num(r[8])); F.ab.push(num(r[11]));
    F.ph.push(num(r[12])); F.tt.push(num(r[13])); F.sc.push(num(r[14])); F.dup.push(isDup);
    dayRows[day] = (dayRows[day] || 0) + 1;
    if (err(r[17]) || err(r[12]) || err(r[19])) lookupErr[name] = (lookupErr[name] || 0) + 1;
  });
  var sorted = dates.slice().sort(), pos = {}; sorted.forEach(function (d, i) { pos[d] = i; });
  F.d = F.d.map(function (x) { return pos[dates[x]]; });
  var missingDays = [];
  if (sorted.length > 1) for (var d = sorted[0]; d < sorted[sorted.length - 1]; d = MV_addDays_(d, 1)) if (!dayRows[d]) missingDays.push(d);
  return {
    version: 1, dates: sorted, agents: agents, f: F,
    health: { rows: F.d.length, days: sorted.map(function (x) { return [x, dayRows[x]]; }), missingDays: missingDays, duplicates: dups,
              lookupErrors: Object.keys(lookupErr).map(function (n) { return { name: n, rows: lookupErr[n] }; }) }
  };
}

/** Paid Hours: rows and hours per day (shows which days have NICE data). */
function MVD_paidDays_(ss) {
  var sh = ss.getSheetByName(MVCC.PAID), last = MV_lastRow_(sh, 1), out = {};
  if (last < 2) return [];
  sh.getRange(2, 1, last - 1, MVCC.PAID_COLS).getValues().forEach(function (r) {
    var d = MV_ymdOf_(r[0]); if (!d) return;
    var o = out[d] || (out[d] = [d, 0, 0]); o[1]++; o[2] += typeof r[7] === 'number' ? r[7] : 0;
  });
  return Object.keys(out).sort().map(function (d) { out[d][2] = Math.round(out[d][2] * 100) / 100; return out[d]; });
}

/** _Flags grouped by type + agent: days and the calls behind them (one line per agent instead of one per agent-day). */
function MVD_flags_(ss) {
  var f = ss.getSheetByName(MVCC.FLAGS), out = {}, total = 0;
  if (!f || f.getLastRow() < 2) return { total: 0, items: [] };
  f.getRange(2, 1, f.getLastRow() - 1, 4).getValues().forEach(function (r) {
    var type = String(r[1] || ''); if (!type) return;
    total++;
    var agent = String(r[2] || '').replace(/^'/, ''), detail = String(r[3] || ''), day = MV_ymdOf_(r[0]) || String(r[0]);
    var k = type + '|' + agent, o = out[k] || (out[k] = { type: type, agent: agent, days: {}, lines: 0, assigned: 0, seconds: 0 });
    o.lines++; o.days[day] = 1;
    var m = /([\d,]+) assigned/.exec(detail); if (m && type !== 'DUPLICATE_IDENTICAL' && type !== 'DUPLICATE_DIFFERENT') o.assigned += Number(m[1].replace(/,/g, ''));
    var d2 = /Rows: (\d+)\//.exec(detail); if (d2 && /^DUPLICATE/.test(type)) o.assigned += Number(d2[1]);
    var s = /\((\d+) s\)/.exec(detail); if (s) o.seconds += Number(s[1]);
  });
  var items = Object.keys(out).map(function (k) { var o = out[k]; return { type: o.type, agent: o.agent, days: Object.keys(o.days).length, lines: o.lines, assigned: o.assigned, seconds: o.seconds }; })
    .sort(function (a, b) { return a.type < b.type ? -1 : a.type > b.type ? 1 : b.days - a.days || a.agent.localeCompare(b.agent); });
  return { total: total, items: items.slice(0, 300) };
}

function MVD_log_(ss) {
  try {
    var l = ss.getSheetByName(MVCC.LOG), ll = l ? l.getLastRow() : 0;
    if (ll < 2) return [];
    var n = Math.min(10, ll - 1);
    return l.getRange(ll - n + 1, 1, n, 12).getValues().reverse().map(function (x) {
      return [x[0] instanceof Date ? x[0].getTime() : String(x[0]), String(x[1]), MV_ymdOf_(x[2]) || String(x[2]), MV_ymdOf_(x[3]) || String(x[3]), String(x[4]),
              x[5], x[6], x[7], String(x[10]), String(x[11]).slice(0, 400)];
    });
  } catch (e) { return []; }
}

/* ============================== CACHE (gzip + base64 chunks; same pattern as Dash_Adherence.gs) ============================== */
function MVD_cacheGet_(stamp) {
  try {
    var c = CacheService.getScriptCache(), meta = c.get(MVD.CACHE_KEY + '_META');
    if (!meta) return null;
    meta = JSON.parse(meta);
    if (meta.stamp !== stamp) return null;
    var keys = []; for (var i = 0; i < meta.n; i++) keys.push(MVD.CACHE_KEY + '_' + i);
    var got = c.getAll(keys), b64 = '';
    for (var j = 0; j < meta.n; j++) { var part = got[MVD.CACHE_KEY + '_' + j]; if (part === undefined || part === null) return null; b64 += part; }
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString());
  } catch (e) { return null; }
}
function MVD_cachePut_(stamp, payload) {
  try {
    var c = CacheService.getScriptCache();
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(payload), 'application/json')).getBytes());
    var n = Math.ceil(b64.length / MVD.CACHE_CHUNK), put = {};
    if (n > 40) return;
    for (var i = 0; i < n; i++) put[MVD.CACHE_KEY + '_' + i] = b64.slice(i * MVD.CACHE_CHUNK, (i + 1) * MVD.CACHE_CHUNK);
    put[MVD.CACHE_KEY + '_META'] = JSON.stringify({ stamp: stamp, n: n });
    c.putAll(put, MVD.CACHE_TTL);
  } catch (e) { /* optimisation only */ }
}