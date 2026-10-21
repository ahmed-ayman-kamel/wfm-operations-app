/**
 * Dash_Acw.gs — NEW FILE. Server side of the ACW Performance dashboard.
 * -----------------------------------------------------------------------------
 * Reads the two raw tabs of the ACW Data spreadsheet and the Data Base roster and returns ONE compact columnar payload:
 * one fact per (day × agent) with Assigned, Accepted and ACW minutes. The page does every filter, grouping and ratio in the
 * browser (all six report levels: Account, LOB, SDACMs, Supervisor, Language, Agent), so a click never calls the server.
 *
 * Every figure is a ratio of sums, exactly like the ACW_Report workbook:
 *   ABN            = Σ Assigned − Σ Accepted
 *   Achieved AVG   = Σ ACW minutes × 60 ÷ Σ Accepted      (seconds per accepted call)
 *   Variance       = Target − Achieved AVG                (positive = faster than target)
 *   Overall %      = Target ÷ Achieved AVG                (≥ 100% = Achieved)
 * Target = _Control!B15 (10 s in the workbook). Agents without accepted calls have no average ("No calls"); the workbook
 * showed "_" and "Achieved" for them.
 *
 * Who is who: Call Events K (Interpreter ID) and ACW Raw Data D (Agent ID) are the Nice ID; everything else (LOB = Language
 * Group, SDACMs = Manager, Supervisor, Language = Seat Language, Queue) is read from the Data Base roster by that ID, with the
 * same cleaning as the loader (Acw.gs). A Call Events row whose ID lookup failed is matched by name (aliases first); a row that
 * still has no match is left out of the numbers and listed under Data health.
 *
 * Public (guarded by requireDashboardAccess_('acw')):
 *   getAcwDashboardData()  -> { ok, stamp, cached, payload }
 *   getAcwDashboardStamp() -> { ok, stamp }   (cheap; the page polls it)
 * Depends on Dashboards.gs, Mvcc.gs and Acw.gs. No ScriptApp, no new OAuth scope.
 */

var ACD = {
  CACHE_KEY: 'ACD_FACTS_V1',
  CACHE_TTL: 6 * 60 * 60,
  CACHE_CHUNK: 90000
};

function getAcwDashboardData() {
  requireDashboardAccess_('acw');
  var ss = AC_ss_(), stamp = ACD_stamp_(ss);
  var hit = ACD_cacheGet_(stamp);
  var payload = hit || ACD_build_(ss, stamp);
  if (!hit) ACD_cachePut_(stamp, payload);
  payload.today = AC_today_();
  payload.target = AC_target_(ss);                                    // per request, so a new target never waits for the cache
  payload.canRun = MV_canRun_(dashRole_());
  payload.backfill = AC_backfillPlan_(payload.today);
  payload.nicePlan = MV_paidPlan_(payload.today);
  return { ok: true, stamp: stamp, cached: !!hit, payload: payload };
}

function getAcwDashboardStamp() {
  requireDashboardAccess_('acw');
  return { ok: true, stamp: ACD_stamp_(AC_ss_()) };
}

/** Last Call Events load + last ACW load + lookup checksum (changes when a Data Base edit changes a looked-up value). */
function ACD_stamp_(ss) {
  var c = ss.getSheetByName(ACW.CONTROL);
  if (!c) return 'none';
  var v = c.getRange('B2:B' + ACW.CHECKSUM_ROW).getValues(), t = function (x) { return x instanceof Date ? x.getTime() : String(x || ''); };
  return t(v[0][0]) + '|' + t(v[4][0]) + '|' + String(v[ACW.CHECKSUM_ROW - 2][0]);
}

function ACD_build_(ss, stamp) {
  var ce = ss.getSheetByName(ACW.CE), raw = ss.getSheetByName(ACW.RAW);
  var lc = ce ? MV_lastRow_(ce, 1) : 0, lr = raw ? MV_lastRow_(raw, 1) : 0;
  var ceRows = lc >= 2 ? ce.getRange(2, 1, lc - 1, ACW.CE_TOTAL_COLS).getValues() : [];
  var rawRows = lr >= 2 ? raw.getRange(2, 1, lr - 1, ACW.RAW_TOTAL_COLS).getValues() : [];
  var roster = AC_loadRoster_(ss);
  var p = ACD_aggregate_(ceRows, rawRows, roster, AC_aliasMap_(ss));
  var c = ss.getSheetByName(ACW.CONTROL), ctl = c ? c.getRange('B2:B11').getValues().map(function (x) { return x[0]; }) : [];
  var ms = function (x) { return x instanceof Date ? x.getTime() : null; };
  p.lastLoad = ms(ctl[0]); p.lastPeriod = String(ctl[1] || ''); p.lastStatus = String(ctl[2] || ''); p.lastBy = String(ctl[8] || '');
  p.lastAcw = ms(ctl[4]); p.acwPeriod = String(ctl[5] || ''); p.acwStatus = String(ctl[6] || ''); p.acwBy = String(ctl[9] || '');
  p.dedupe = AC_dedupeSetting_(ss);
  var db = AC_dbStatus_(ss, false);
  p.db = { ok: db.ok, message: db.message || '', agents: db.rows || 0 };
  p.flags = ACD_flags_(ss);
  p.log = ACD_log_(ss);
  p.stamp = stamp;
  return p;
}

/**
 * Pure: Call Events A:U + ACW Raw Data A:P + roster → payload.
 * Call Events row: 0 Date 1 Vendor 2 Agent name 3 Assigned 4 Accepted 5 CSR 6 Timed Out 7 Cancelled 8 TO rate 9 Canc rate
 *                  10 Interpreter ID (Nice ID) 11 Interpreter Name (Name on Nice) 12 TL 13 Seat 14 Language ...
 * ACW row:         0 Date 1 Entity ID 2 Entity Name 3 Agent ID (Nice ID) 4 Agent Name 5 Activity 6 Length (day fraction) 7 Percent 8 ACW hours ...
 * roster = AC_loadRoster_ result ({ people, byNice, issues, resolve }), aliases = AC_aliasMap_.
 */
function ACD_aggregate_(ceRows, rawRows, roster, aliases) {
  var err = function (v) { return typeof v === 'string' && /^#(N\/A|REF|VALUE|DIV|NAME|NUM|ERROR|NULL)/i.test(v); };
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : (v === '' || v === null || v === undefined || err(v) || isNaN(Number(v)) ? 0 : Number(v)); };
  var ymd = function (v) { var d = AC_dateYmd_(v); return d; };
  var people = roster.people, ix = {}, memo = {};
  people.forEach(function (p, i) { if (p.niceId !== '' && p.niceId !== undefined) ix[String(p.niceId)] = i; });
  var agents = people.map(function (p) {
    return { name: p.name, nn: p.nice, nice: p.niceId === '' || p.niceId === undefined ? '' : String(p.niceId), lg: p.lg, sd: p.mgr, tl: p.sup, lang: p.lang, queue: p.queue,
             seat: p.seat || '', st: p.status || '', cls: p.cls || '', prod: p.prod || '' };
  });
  var dayOf = function (v) {
    if (v instanceof Date) { var k = v.getTime(); return memo[k] || (memo[k] = ymd(v)); }
    return ymd(v);
  };
  var facts = {}, dayCe = {}, dayRaw = {}, dups = { rows: 0, assigned: 0, accepted: 0 }, accGtAs = 0, how = { id: 0 };
  var lookupErr = {}, unmatchedCe = {}, unmatchedRaw = {}, cross = { checked: 0, mismatch: 0, examples: [] }, ceUsed = 0, rawUsed = 0;
  var fact = function (day, a) {
    var k = day + '|' + a, f = facts[k];
    if (!f) f = facts[k] = { day: day, a: a, as: 0, ac: 0, acw: 0, das: 0, dac: 0, dn: 0, seen: 0 };
    return f;
  };
  ceRows.forEach(function (r) {
    var name = AC_clean_(r[2]);
    if (!name) return;
    var day = dayOf(r[0]);
    if (!day) return;
    dayCe[day] = (dayCe[day] || 0) + 1;
    var as = num(r[3]), ac = num(r[4]), a = -1, idRaw = r[10];
    if (typeof idRaw === 'number' || (typeof idRaw === 'string' && /^\d+$/.test(idRaw.trim()))) {
      var key = String(Number(idRaw));
      if (ix.hasOwnProperty(key)) { a = ix[key]; how.id++; }
    } else if (err(idRaw)) lookupErr[name] = (lookupErr[name] || 0) + 1;
    if (a < 0) {
      var res = roster.resolve(name, aliases, '');
      if (res && res.p && res.p.niceId !== '' && ix.hasOwnProperty(String(res.p.niceId))) { a = ix[String(res.p.niceId)]; how[res.how] = (how[res.how] || 0) + 1; }
    }
    if (a < 0) { var u = unmatchedCe[name] || (unmatchedCe[name] = { name: name, rows: 0, assigned: 0 }); u.rows++; u.assigned += as; return; }
    if (typeof r[11] === 'string' && !err(r[11]) && r[11] !== '') {                                  // sheet lookup vs roster
      cross.checked++;
      if (AC_norm_(r[11]) !== AC_norm_(agents[a].nn)) { cross.mismatch++; if (cross.examples.length < 5) cross.examples.push(name + ': sheet "' + r[11] + '" vs roster "' + agents[a].nn + '"'); }
    }
    if (ac > as) accGtAs++;
    var f = fact(day, a);
    f.as += as; f.ac += ac; f.seen++; ceUsed++;
    if (f.seen > 1) { f.dn++; f.das += as; f.dac += ac; dups.rows++; dups.assigned += as; dups.accepted += ac; }
  });
  var unreadable = 0;
  rawRows.forEach(function (r) {
    var idRaw = r[3];
    if (idRaw === '' || idRaw === null || idRaw === undefined) return;
    var act = AC_clean_(r[5]).toUpperCase();
    if (act && act !== 'ACW') return;
    var day = dayOf(r[0]);
    if (!day) return;
    dayRaw[day] = (dayRaw[day] || 0) + 1;
    var mins = 0;
    if (typeof r[8] === 'number' && isFinite(r[8])) mins = Math.round(r[8] * 60);                    // I = ROUND(Length*1440,0)/60
    else if (typeof r[6] === 'number' && isFinite(r[6])) mins = Math.round(r[6] * 1440);
    else unreadable++;
    var a = -1;
    if (typeof idRaw === 'number' || (typeof idRaw === 'string' && /^\d+$/.test(String(idRaw).trim()))) { var key = String(Number(idRaw)); if (ix.hasOwnProperty(key)) a = ix[key]; }
    if (a < 0) {
      var k2 = String(idRaw), u = unmatchedRaw[k2] || (unmatchedRaw[k2] = { id: k2, name: AC_clean_(r[4]), minutes: 0, rows: 0 });
      u.minutes += mins; u.rows++;
      return;
    }
    fact(day, a).acw += mins; rawUsed++;
  });
  var days = {}; Object.keys(dayCe).concat(Object.keys(dayRaw)).forEach(function (d) { days[d] = 1; });
  var dates = Object.keys(days).sort(), pos = {}; dates.forEach(function (d, i) { pos[d] = i; });
  var keys = Object.keys(facts).sort(function (x, y) {
    var a = facts[x], b = facts[y];
    return a.day < b.day ? -1 : a.day > b.day ? 1 : a.a - b.a;
  });
  var F = { d: [], a: [], as: [], ac: [], acw: [], das: [], dac: [], dn: [] };
  keys.forEach(function (k) { var f = facts[k]; F.d.push(pos[f.day]); F.a.push(f.a); F.as.push(f.as); F.ac.push(f.ac); F.acw.push(f.acw); F.das.push(f.das); F.dac.push(f.dac); F.dn.push(f.dn); });
  var missing = function (set) {
    var ks = Object.keys(set).sort(), out = [];
    if (ks.length > 1) for (var d = ks[0]; d < ks[ks.length - 1]; d = MV_addDays_(d, 1)) if (!set[d]) out.push(d);
    return out;
  };
  var iss = roster.issues || {};
  var top = function (o, n) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return (b.rows || 0) - (a.rows || 0); }).slice(0, n); };
  return {
    version: 1, dates: dates, agents: agents, f: F,
    health: {
      ceRows: ceUsed, acwRows: rawUsed, days: dates.map(function (d) { return [d, dayCe[d] || 0, dayRaw[d] || 0]; }),
      missingCeDays: missing(dayCe), missingAcwDays: missing(dayRaw),
      duplicates: dups, acceptedOverAssigned: accGtAs, unreadableAcw: unreadable,
      lookupErrors: Object.keys(lookupErr).map(function (n) { return { name: n, rows: lookupErr[n] }; }).slice(0, 40),
      unmatchedCe: top(unmatchedCe, 40), unmatchedAcw: top(unmatchedRaw, 40), matchedBy: how, cross: cross,
      roster: {
        agents: people.length, duplicateNiceIds: (iss.duplicateNiceIds || []).slice(0, 20), blankNiceId: iss.blankNiceId || 0,
        swapped: (iss.swappedNames || []).length, swappedExamples: (iss.swappedNames || []).slice(0, 8),
        textDates: iss.textDates || 0, unreadableDates: iss.unreadableDates || 0, caseVariants: (iss.caseVariants || []).slice(0, 12),
        noManager: iss.noManager || 0, noSupervisor: iss.noSupervisor || 0
      }
    }
  };
}

/** _Flags grouped by type + agent: days and the calls / minutes behind them (one line per agent instead of one per agent-day). */
function ACD_flags_(ss) {
  var f = ss.getSheetByName(ACW.FLAGS), out = {}, total = 0;
  if (!f || f.getLastRow() < 2) return { total: 0, items: [] };
  f.getRange(2, 1, f.getLastRow() - 1, 4).getValues().forEach(function (r) {
    var type = String(r[1] || ''); if (!type) return;
    total++;
    var agent = String(r[2] || '').replace(/^'/, ''), detail = String(r[3] || ''), day = MV_ymdOf_(r[0]) || String(r[0]);
    var k = type + '|' + agent, o = out[k] || (out[k] = { type: type, agent: agent, days: {}, lines: 0, assigned: 0, minutes: 0, note: '' });
    o.lines++; o.days[day] = 1;
    var m = /(\d+) assigned/.exec(detail); if (m && !/^DUPLICATE/.test(type)) o.assigned += Number(m[1]);
    var d2 = /Rows: \d+\/\d+ and (\d+)\//.exec(detail); if (d2 && /^DUPLICATE/.test(type)) o.assigned += Number(d2[1]);
    var mm = /(\d+) ACW minutes/.exec(detail); if (mm) o.minutes += Number(mm[1]);
    if (type === 'ALIAS_LEARNED' && !o.note) { var al = /Matched "([^"]+)"/.exec(detail); if (al) o.note = al[1]; }
  });
  var items = Object.keys(out).map(function (k) { var o = out[k]; return { type: o.type, agent: o.agent, days: Object.keys(o.days).length, lines: o.lines, assigned: o.assigned, minutes: o.minutes, note: o.note }; })
    .sort(function (a, b) { return a.type < b.type ? -1 : a.type > b.type ? 1 : b.days - a.days || a.agent.localeCompare(b.agent); });
  return { total: total, items: items.slice(0, 300) };
}

/** Last 10 lines of _Load Log (newest first): [at, by, from, to, mode, tab, rows, status, message]. */
function ACD_log_(ss) {
  try {
    var l = ss.getSheetByName(ACW.LOG), ll = l ? l.getLastRow() : 0;
    if (ll < 2) return [];
    var n = Math.min(10, ll - 1);
    return l.getRange(ll - n + 1, 1, n, 11).getValues().reverse().map(function (x) {
      return [x[0] instanceof Date ? x[0].getTime() : String(x[0]), String(x[1]), MV_ymdOf_(x[2]) || String(x[2]), MV_ymdOf_(x[3]) || String(x[3]), String(x[4]), String(x[5]), x[6], String(x[9]), String(x[10]).slice(0, 400)];
    });
  } catch (e) { return []; }
}

/* ============================== CACHE (gzip + base64 chunks; same pattern as Dash_Mvcc.gs) ============================== */
function ACD_cacheGet_(stamp) {
  try {
    var c = CacheService.getScriptCache(), meta = c.get(ACD.CACHE_KEY + '_META');
    if (!meta) return null;
    meta = JSON.parse(meta);
    if (meta.stamp !== stamp) return null;
    var keys = []; for (var i = 0; i < meta.n; i++) keys.push(ACD.CACHE_KEY + '_' + i);
    var got = c.getAll(keys), b64 = '';
    for (var j = 0; j < meta.n; j++) { var part = got[ACD.CACHE_KEY + '_' + j]; if (part === undefined || part === null) return null; b64 += part; }
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString());
  } catch (e) { return null; }
}
function ACD_cachePut_(stamp, payload) {
  try {
    var c = CacheService.getScriptCache();
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(payload), 'application/json')).getBytes());
    var n = Math.ceil(b64.length / ACD.CACHE_CHUNK), put = {};
    if (n > 40) return;
    for (var i = 0; i < n; i++) put[ACD.CACHE_KEY + '_' + i] = b64.slice(i * ACD.CACHE_CHUNK, (i + 1) * ACD.CACHE_CHUNK);
    put[ACD.CACHE_KEY + '_META'] = JSON.stringify({ stamp: stamp, n: n });
    c.putAll(put, ACD.CACHE_TTL);
  } catch (e) { /* optimisation only */ }
}
