/**
 * Acw.gs — NEW FILE (changes no existing file). Depends on Mvcc.gs (re-uses its Sisense client and helpers).
 * -----------------------------------------------------------------------------
 * ACW report → the "ACW Data" spreadsheet (the workbook that replaces ACW_Report_Oct26.xlsx).
 *
 *   Data Base               ← IMPORTRANGE of the team's Database workbook (replaces Data Base 1, Data Base 2 and Nice Database). Never written here.
 *   A. Call Events - Rawdata ← Sisense "Vendor Dashboard" › Calls Event by Vendor Log   (one pull per day; same widget as MVCC)
 *   B. ACW Raw Data          ← NICE Time Utilization, Data = Agent Activity, code ACW only, details by day + agent + activity
 *                              (the WFM NICE Connector runs it in the person's own browser)
 *
 * The two retrieval recipes are the owner's instruction card (2026-10-20):
 *   Call Events: Sisense Vendor Dashboard → last 3 days one by one → Status = Active + Terminated - Eligible → Call Event Details →
 *                remove the N/A results (agents that are not in the database).
 *   ACW:         NICE Time Utilization Report (MTD) → details by day, agent, activity → code ACW → add to raw data, fill the equations → check.
 *
 * Rules (same as MVCC unless noted):
 *   - Reports are updated only up to YESTERDAY (New York time).
 *   - Sisense can still change a day for a few days → every run re-pulls the last 3 days and REPLACES those dates.
 *   - ACW (NICE) is month-to-date and replaced on each run (on the 1st it reloads the whole previous month).
 *   - Agents that are not in the Data Base are NOT written; they are listed in _Flags (this is the "remove N/A results" step).
 *   - Names Sisense spells differently from the Data Base (accents, spaces, "Last, First") are matched safely (unique match only)
 *     and the match is saved in the Aliases tab so the sheet formulas resolve too. Ambiguous names are never guessed.
 *   - Duplicate (date, agent) rows in Call Events: KEEP (as Sisense returns them; this is what the Excel report did) or REMOVE = _Control!B14.
 *   - ACW target (seconds) = _Control!B15 (10, as in the Excel report).
 *
 * Public entry points (all guarded):
 *   setupAcwSheet()                   editor   requireSetupAccess_
 *   repairAcwFormulas()               editor   requireSetupAccess_
 *   acwCheckSetup()                   editor   requireSetupAccess_ (read-only)
 *   TEST_acwSisenseProbe(day)         editor   requireSetupAccess_ (logs in, fetches one day, writes nothing)
 *   acwBackfillSisense()              app      run roles (last 3 days → Call Events)
 *   acwLoadSisenseRange(from, to)     app/editor run roles or owner (<= 31 days; resumable)
 *   acwStartNice()                    app      run roles (returns the NICE job for the 1st → yesterday)
 *   acwSaveNice(runId, csv, meta)     app      run roles
 *   acwReportRunFailure(...)          app      run roles
 * Script Properties: ACW_SPREADSHEET_ID (new), SISENSE_USERNAME / SISENSE_PASSWORD (already used by MVCC and Voyce).
 * No ScriptApp, no new OAuth scope.
 */

var ACW = {
  TZ: 'America/New_York',
  PROP_ID: 'ACW_SPREADSHEET_ID',
  CE: 'Call Events - Rawdata', RAW: 'ACW Raw Data', DB: 'Data Base', DB_ALT: 'Database', ALIAS: 'Aliases',
  CONTROL: '_Control', LOG: '_Load Log', FLAGS: '_Flags',
  RUN_FLAG: 'ACW_RUNNING', RUN_FLAG_TTL: 330, RUN_TTL: 1800,
  BACKFILL_DAYS: 3, MAX_DAYS: 31, RUN_BUDGET_MS: 240000, SIS_PARALLEL: 6,
  CE_LOAD_COLS: 10, CE_TOTAL_COLS: 21,           // A:J from Sisense, K:U row-1 formulas
  RAW_LOAD_COLS: 8, RAW_TOTAL_COLS: 16,          // A:H from NICE,    I:P row-1 formulas
  DEDUPE_CELL: 'B14', TARGET_CELL: 'B15', CHECKSUM_ROW: 16, DEFAULT_TARGET: 10,
  CE_HEADERS: ['Date', 'Vendor Name', 'Agent name', 'Assigned Calls', 'Accepted Calls', 'CSR', 'Timed Out', 'Cancelled', 'Timed Out Rate', 'Cancelled Rate'],
  RAW_HEADERS: ['Date', 'Entity ID', 'Entity Name', 'Agent ID', 'Agent Name', 'Agent Activity', 'Length', 'Percent'],
  // Data Base columns used by the formulas, found by header name (row 1).
  DB_COLS: { icol: 'Interpreter name', nname: 'Name on Nice', seat: 'Seat Number', lg: 'Language Group', email: 'Email Address', nice: 'Nice ID',
             mgr: 'Manager', sup: 'Supervisor', seatLang: 'Seat Language', prod: 'Production Start date' },
  // Optional Data Base columns the dashboard shows when present.
  DB_OPT: { first: 'First name', last: 'Last Name', status: 'Status', id: 'ID', cls: 'Classification', tenure: 'Tenurity' },
  NICE_ACW_CODE: { id: 'YOUR_NICE_CODE_ACW', oid: 'YOUR_NICE_CODE_ACW', name: 'ACW' }
};

/* ============================== NAME / ROSTER CLEANING (pure) ============================== */
function AC_strip_(s) {
  s = String(s === null || s === undefined ? '' : s);
  try { s = s.normalize('NFKD'); } catch (e) { /* very old runtime */ }
  return s.replace(/[̀-ͯ]/g, '');
}
/** lower case, accents removed, spaces collapsed. */
function AC_norm_(s) { return AC_strip_(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
/** letters and digits only (so "Abu baker" = "Abubaker", "Ali, Esraa" = "Ali Esraa"). */
function AC_squash_(s) { return AC_norm_(s).replace(/[^a-z0-9]/g, ''); }
function AC_clean_(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }
/** "Last, First (FG)" → { first, last } ('' when the text does not have that shape). */
function AC_niceParts_(nn) {
  var m = /^\s*([^,]+),\s*(.+?)\s*(\(FG\))?\s*$/.exec(String(nn || ''));
  return m ? { first: m[2], last: m[1] } : { first: '', last: '' };
}
/** Date cell → 'yyyy-MM-dd' or ''. Accepts Date, Sheets serial, 'yyyy-MM-dd' and the text 'D/M/YYYY' (the Database writes some dates as text). */
function AC_dateYmd_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : MV_ymdOf_(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10) : '';
  var s = AC_clean_(v), m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);                  // D/M/YYYY (as typed in the Database)
  if (m) { var d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]); if (mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()) return y + '-' + MV_pad_(mo) + '-' + MV_pad_(d); }
  return '';
}
function AC_isErr_(v) { return typeof v === 'string' && /^#(N\/A|REF|VALUE|DIV|NAME|NUM|ERROR|NULL)/i.test(v); }

/**
 * Roster from the Data Base tab (header row + rows). Pure.
 * Cleaning: text trimmed and spaces collapsed; Language Group / Manager / Supervisor / Language spellings that differ only by case
 * are merged (SUMIFS in the Excel report was case-insensitive too); Nice ID read as a number when it is one; Queue derived
 * (the Database has no Queue column): Language Group "PENs" → Operator, anything else → VRI (100% equal to the old Nice Database).
 * `cols` maps keys of ACW.DB_COLS (+ optional ones) to 0-based column positions.
 */
function AC_roster_(header, rows, cols) {
  var canon = { lg: {}, mgr: {}, sup: {}, lang: {} };
  var people = [], byNice = {}, issues = { duplicateNiceIds: [], textDates: 0, unreadableDates: 0, swappedNames: [], blankNiceId: 0, caseVariants: [], noManager: 0, noSupervisor: 0 };
  var pick = function (kind, v) {
    v = AC_clean_(v); if (!v) return '(blank)';
    var k = v.toLowerCase(), c = canon[kind][k];
    if (c && c !== v && issues.caseVariants.indexOf(c + ' / ' + v) < 0) issues.caseVariants.push(c + ' / ' + v);
    return c || (canon[kind][k] = v);
  };
  var get = function (r, key) { var i = cols[key]; return i === undefined || i < 0 ? '' : r[i]; };
  var seenNice = {}, seenId = {};
  rows.forEach(function (r) {
    var name = AC_clean_(get(r, 'icol')), nice = AC_clean_(get(r, 'nname'));
    if (!name && !nice) return;
    var nid = get(r, 'nice'), nidNum = typeof nid === 'number' ? nid : (/^\d+$/.test(AC_clean_(nid)) ? Number(AC_clean_(nid)) : AC_clean_(nid));
    var lg = pick('lg', get(r, 'lg'));
    var prodRaw = get(r, 'prod'), prod = AC_dateYmd_(prodRaw);
    if (typeof prodRaw === 'string' && AC_clean_(prodRaw)) { if (prod) issues.textDates++; else issues.unreadableDates++; }
    var p = { name: name || nice, nice: nice, niceId: nidNum, email: AC_clean_(get(r, 'email')).toLowerCase(), seat: AC_clean_(get(r, 'seat')),
              lg: lg, mgr: pick('mgr', get(r, 'mgr')), sup: pick('sup', get(r, 'sup')), lang: pick('lang', get(r, 'seatLang')),
              queue: lg.toLowerCase() === 'pens' ? 'Operator' : 'VRI', prod: prod,
              status: AC_clean_(get(r, 'status')), cls: AC_clean_(get(r, 'cls')) };
    if (p.mgr === '(blank)') issues.noManager++;
    if (p.sup === '(blank)') issues.noSupervisor++;
    var f = AC_clean_(get(r, 'first')), l = AC_clean_(get(r, 'last')), parts = AC_niceParts_(nice);
    if (f && l && parts.first && AC_norm_(f) !== AC_norm_(parts.first) && AC_norm_(f) === AC_norm_(parts.last) && AC_norm_(l) === AC_norm_(parts.first)) issues.swappedNames.push(p.name);
    if (p.niceId === '' || p.niceId === undefined) issues.blankNiceId++;
    else { var k = String(p.niceId); if (seenNice[k]) issues.duplicateNiceIds.push(k); seenNice[k] = 1; byNice[k] = p; }
    people.push(p);
  });
  return { people: people, byNice: byNice, issues: issues, resolver: null };
}

/**
 * Name → agent. Chain (stops at the first step that gives exactly ONE person; several = ambiguous = unresolved):
 *   1 alias (Aliases tab) 2 same text ignoring case/accents/spaces 3 same letters and digits only 4 e-mail 5 first + last name taken from "Name on Nice".
 * aliases: { lowercase sisense name: lowercase database name } (as in the Aliases tab). Returns { p, how } with how in
 * exact | normalized | email | first+last | ambiguous | unresolved.
 */
function AC_resolver_(roster) {
  var by = { n: {}, sq: {}, em: {}, ft: {} };
  var add = function (m, k, p) { if (!k) return; (m[k] = m[k] || []).push(p); };
  roster.people.forEach(function (p) {
    add(by.n, AC_norm_(p.name), p); add(by.sq, AC_squash_(p.name), p); add(by.em, p.email, p);
    var t = AC_niceParts_(p.nice), f = AC_norm_(t.first).split(' ')[0] || '', l = AC_norm_(t.last).split(' ').pop() || '';
    if (f && l) add(by.ft, f + '|' + l, p);
  });
  return function (name, aliases, email) {
    var raw = AC_clean_(name), n = AC_norm_(raw), al = aliases || {}, a = al[raw.toLowerCase()];
    if (a) n = AC_norm_(a);
    var one = function (list) { return list && list.length === 1 ? list[0] : null; }, amb = false, hit;
    var chk = function (list, how) { if (list && list.length > 1) amb = true; hit = one(list); return hit ? { p: hit, how: how } : null; };
    var r = chk(by.n[n], 'exact') || chk(by.sq[AC_squash_(n)], 'normalized');
    if (r) return r;
    var em = AC_clean_(email).toLowerCase();
    if (em && (r = chk(by.em[em], 'email'))) return r;
    var tk = n.split(' ');
    if (tk.length >= 2 && (r = chk(by.ft[tk[0] + '|' + tk[tk.length - 1]], 'first+last'))) return r;
    return { p: null, how: amb ? 'ambiguous' : 'unresolved' };
  };
}

/* ============================== ROW BUILDERS (pure) ============================== */
/**
 * Call Events rows for one day (Sisense widget A objects). Applies: Data Base filter ("remove N/A results"), name matching with
 * alias learning, duplicate flags/removal, a sanity flag when Accepted > Assigned.
 * @returns { rows:[{day,ord,v}], flags:[[date,type,agent,detail]], skipped, dupes, learned:[[sisenseName, dbName, how]] }
 */
function AC_buildCe_(rows, ymd, resolve, aliases, dedupe) {
  var out = [], flags = [], seen = {}, skipped = 0, dupes = 0, learned = {};
  rows.forEach(function (o) {
    var name = AC_clean_(o['Agent name']);
    if (!name) return;
    var as = MV_num_(o['Assigned Calls']), ac = MV_num_(o['Accepted Calls']);
    var res = resolve(name, aliases, o['Email']);
    if (!res.p) {
      skipped++;
      flags.push([ymd, 'NOT_IN_DATABASE', name, 'Not written to Call Events: ' + as + ' assigned, ' + ac + ' accepted calls' + (res.how === 'ambiguous' ? ' (the name matches more than one Data Base row)' : '') +
        '. Add the agent to the Data Base (or an alias) to include them.']);
      return;
    }
    var p = res.p, lower = name.toLowerCase(), sheetKey = (aliases && aliases[lower]) || lower;
    if (sheetKey !== AC_clean_(p.name).toLowerCase() && !learned[lower]) {
      learned[lower] = [name, p.name, res.how];
      flags.push([ymd, 'ALIAS_LEARNED', name, 'Matched "' + p.name + '" by ' + res.how + '; saved in the Aliases tab so the sheet formulas find it.']);
    }
    var row = [ymd, MV_text_(o['Vendor Name']), MV_text_(name), as, ac, MV_num_(o['CSR']), MV_num_(o['Timed Out']), MV_num_(o['Cancelled']),
               MV_num_(o['Timed Out Rate']), MV_num_(o['Cancelled Rate'])];
    if (typeof as === 'number' && typeof ac === 'number' && ac > as) flags.push([ymd, 'ACCEPTED_GT_ASSIGNED', name, 'Accepted ' + ac + ' is more than assigned ' + as + '; kept as Sisense returns it.']);
    var key = String(p.niceId);
    if (seen[key]) {
      dupes++;
      var same = JSON.stringify(seen[key]) === JSON.stringify(row);
      flags.push([ymd, same ? 'DUPLICATE_IDENTICAL' : 'DUPLICATE_DIFFERENT', name,
        (dedupe === 'REMOVE' ? 'Second row removed. ' : 'Both rows kept: assigned and accepted calls are counted twice for this agent and day (the Excel report did the same). ') +
        'Rows: ' + seen[key][3] + '/' + seen[key][4] + ' and ' + row[3] + '/' + row[4] + ' (assigned/accepted).']);
      if (dedupe === 'REMOVE') return;
    } else seen[key] = row;
    out.push({ day: ymd, ord: 0, v: row });
  });
  return { rows: out, flags: flags, skipped: skipped, dupes: dupes, learned: Object.keys(learned).map(function (k) { return learned[k]; }) };
}

/**
 * ACW Raw Data rows from the NICE rows MV_paidRows_ returns ({day, v:[ymd, entityId, entityName, agentId, agentName, activity, length, hours, percent]}).
 * Keeps only the activity ACW, drops agents that are not in the Data Base (flagged), and returns the sheet columns A:H.
 */
function AC_buildRaw_(niceRows, byNice) {
  var out = [], flags = [], other = {}, missing = {}, kept = 0;
  niceRows.forEach(function (r) {
    var v = r.v, act = AC_clean_(v[5]);
    if (act.toUpperCase() !== 'ACW') { other[act] = (other[act] || 0) + 1; return; }
    var id = String(v[3]);
    if (!byNice[id]) {
      var k = r.day + '|' + id; missing[k] = missing[k] || { day: r.day, id: id, name: v[4], mins: 0 };
      missing[k].mins += Math.round(Number(v[6]) * 1440);
      return;
    }
    out.push({ day: r.day, ord: 0, v: [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[8]] });
    kept++;
  });
  Object.keys(missing).sort().forEach(function (k) {
    var m = missing[k];
    flags.push([m.day, 'ACW_NOT_IN_DATABASE', MV_text_(m.name), 'Agent ID ' + m.id + ' is not in the Data Base; ' + m.mins + ' ACW minutes were not written.']);
  });
  Object.keys(other).forEach(function (a) { flags.push([niceRows.length ? niceRows[0].day : '', 'ACW_OTHER_ACTIVITY', MV_text_(a), other[a] + ' NICE rows with activity "' + a + '" were ignored (only ACW is loaded).']); });
  return { rows: out, flags: flags, kept: kept, ignored: Object.keys(other).reduce(function (s, a) { return s + other[a]; }, 0), missing: Object.keys(missing).length };
}

/* ============================== FORMULAS (row 1 of each raw tab) ============================== */
/**
 * One ARRAYFORMULA per column in row 1 (it shows the header and fills every data row), as in the MVCC workbook.
 * Same lookups as the Excel report, now against the Data Base tab:
 *   Call Events: K Interpreter ID = Nice ID by (alias →) Interpreter name; everything else by that Nice ID.
 *   ACW Raw Data: everything by Agent ID = Nice ID. Both sides are compared as text, so a Nice ID typed as text still matches.
 * `m` = Data Base letters (from the header row), `db` = the tab name. Pure.
 */
function AC_ceFormulas_(m, db) {
  var D = function (c) { return "'" + db + "'!" + c + ':' + c; };
  var R = function (c) { return "'" + db + "'!$" + c + '$2:$' + c; };
  var al = 'IFERROR(XLOOKUP(C2:C,Aliases!A:A,Aliases!B:B),C2:C)';
  var byId = function (c) { return 'XLOOKUP(K2:K&"",' + R(m.nice) + '&"",' + R(c) + ')'; };
  var af = function (h, expr) { return '=ARRAYFORMULA({"' + h + '";IF(A2:A="",,' + expr + ')})'; };
  var prod = 'LET(x,' + byId(m.prod) + ',IF(x="","",IFERROR(DATE(REGEXEXTRACT(x&"","(\\d+)$"),REGEXEXTRACT(x&"","/(\\d+)/"),REGEXEXTRACT(x&"","^(\\d+)")),x)))';
  return {
    K: af('Interpreter ID', 'XLOOKUP(' + al + ',' + D(m.icol) + ',' + D(m.nice) + ')'),
    L: af('Interpreter Name', byId(m.nname)),
    M: af('TL', byId(m.sup)),
    N: af('Seat', byId(m.seat)),
    O: af('Language', byId(m.seatLang)),
    P: af('Login date', prod),
    Q: af('Activity', 'IF(ISNUMBER(P2:P),IF(A2:A>=P2:P,"In production","Nesting"),"")'),
    R: af('LOB', 'IF(' + byId(m.lg) + '="PENs","Operator","VRI")'),
    S: af('Language Group', byId(m.lg)),
    T: af('SDACMs', byId(m.mgr)),
    U: af('Account', '"Client"')
  };
}
function AC_rawFormulas_(m, db) {
  var R = function (c) { return "'" + db + "'!$" + c + '$2:$' + c; };
  var byId = function (c) { return 'XLOOKUP(D2:D&"",' + R(m.nice) + '&"",' + R(c) + ')'; };
  var af = function (h, expr) { return '=ARRAYFORMULA({"' + h + '";IF(D2:D="",,' + expr + ')})'; };
  return {
    I: af('ACW', 'ROUND(G2:G*1440,0)/60'),
    J: af('FG Name', byId(m.nname)),
    K: af('LOB', 'IF(' + byId(m.lg) + '="PENs","Operator","VRI")'),
    L: af('Language Group', byId(m.lg)),
    M: af('Language', byId(m.seatLang)),
    N: af('Team Leader', byId(m.sup)),
    O: af('SDACMs', byId(m.mgr)),
    P: af('Overall Account', '"Client"')
  };
}
function AC_checksumFormula_(m, db) {
  var D = function (c) { return "'" + db + "'!" + c + '2:' + c; };
  return "=SUMPRODUCT(LEN('" + ACW.CE + "'!K2:T))+SUMPRODUCT(LEN('" + ACW.RAW + "'!J2:O))+SUMPRODUCT(LEN(" +
    [m.nname, m.lg, m.nice, m.mgr, m.sup, m.seatLang].map(D).join('&') + '))';
}

/* ============================== DATA BASE ============================== */
function AC_dbSheet_(ss) { return ss.getSheetByName(ACW.DB) || ss.getSheetByName(ACW.DB_ALT); }
function AC_dbStatus_(ss, wait) {
  var db = AC_dbSheet_(ss);
  if (!db) return { ok: false, message: 'The "' + ACW.DB + '" tab is missing.' };
  var tries = wait ? 6 : 1;
  for (var i = 0; i < tries; i++) {
    var head = db.getRange(1, 1, 1, Math.min(40, db.getMaxColumns())).getValues()[0];
    var a1 = String(db.getRange('A1').getDisplayValue() || '');
    if (/^#(REF|N\/A|ERROR)/i.test(a1)) return { ok: false, message: 'The Data Base import is not working (' + a1 + '). Open the spreadsheet, click ' + db.getName() + '!A1 and press "Allow access" once.' };
    if (head.filter(function (h) { return String(h).trim() !== ''; }).length >= 5) return { ok: true, name: db.getName(), header: head.map(String), rows: Math.max(0, db.getLastRow() - 1) };
    if (i < tries - 1) { Utilities.sleep(2500); SpreadsheetApp.flush(); }
  }
  return { ok: false, message: 'The Data Base tab shows no data (still loading, or "Allow access" is needed on ' + db.getName() + '!A1).' };
}
/** { ok, name, cols:{key:'A'}, idx:{key:0-based}, opt:{key:0-based} } or { ok:false, message }. */
function AC_dbColumns_(ss) {
  var st = AC_dbStatus_(ss, true);
  if (!st.ok) return { ok: false, message: st.message };
  var cols = {}, idx = {}, opt = {}, missing = [];
  var find = function (title) { var w = MV_norm_(title); for (var j = 0; j < st.header.length; j++) if (MV_norm_(st.header[j]) === w) return j; return -1; };
  Object.keys(ACW.DB_COLS).forEach(function (k) { var j = find(ACW.DB_COLS[k]); if (j < 0) missing.push(ACW.DB_COLS[k]); else { cols[k] = MV_col_(j + 1); idx[k] = j; } });
  Object.keys(ACW.DB_OPT).forEach(function (k) { var j = find(ACW.DB_OPT[k]); if (j >= 0) opt[k] = j; });
  if (missing.length) return { ok: false, message: 'The Data Base tab has no column named: ' + missing.join(', ') + '. Check the source tab name in ' + st.name + '!A1 (IMPORTRANGE). Nothing was changed.' };
  return { ok: true, name: st.name, cols: cols, idx: idx, opt: opt, header: st.header };
}
/** Roster object { people, byNice, issues, resolve } read from the Data Base tab. */
function AC_loadRoster_(ss, m) {
  m = m || AC_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  var db = AC_dbSheet_(ss), last = db.getLastRow(), width = Math.max.apply(null, Object.keys(m.idx).map(function (k) { return m.idx[k]; }).concat(Object.keys(m.opt).map(function (k) { return m.opt[k]; }))) + 1;
  var rows = last >= 2 ? db.getRange(2, 1, last - 1, width).getValues() : [];
  var cols = {}; Object.keys(m.idx).forEach(function (k) { cols[k] = m.idx[k]; }); Object.keys(m.opt).forEach(function (k) { cols[k] = m.opt[k]; });
  var roster = AC_roster_(m.header, rows, cols);
  roster.resolve = AC_resolver_(roster);
  roster.rowCount = rows.length;
  return roster;
}
/** Aliases tab: A = name in Sisense, B = name in the Data Base → { lowercase A: lowercase B }. */
function AC_aliasMap_(ss) {
  var sh = ss.getSheetByName(ACW.ALIAS), out = {};
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    var a = AC_clean_(r[0]).toLowerCase(), b = AC_clean_(r[1]).toLowerCase();
    if (a && b) out[a] = b;
  });
  return out;
}
function AC_saveAliases_(ss, learned, ymd) {
  if (!learned.length) return 0;
  var sh = ss.getSheetByName(ACW.ALIAS);
  if (!sh) return 0;
  var have = AC_aliasMap_(ss), add = [];
  learned.forEach(function (x) { if (!have[x[0].toLowerCase()]) { have[x[0].toLowerCase()] = 1; add.push([MV_text_(x[0]), MV_text_(x[1]), 'auto ' + ymd + ' (' + x[2] + ')']); } });
  if (!add.length) return 0;
  var start = Math.max(sh.getLastRow(), 1) + 1;
  if (sh.getMaxRows() < start + add.length) sh.insertRowsAfter(sh.getMaxRows(), start + add.length - sh.getMaxRows());
  sh.getRange(start, 1, add.length, 3).setValues(add);
  return add.length;
}

/* ============================== ENSURE / SETUP ============================== */
function AC_ensureFormulas_(ss) {
  var fixed = [];
  [ACW.CE, ACW.RAW, ACW.ALIAS].forEach(function (n) { if (!ss.getSheetByName(n)) throw new Error('The tab "' + n + '" is missing in the ACW spreadsheet. Run setupAcwSheet once. Nothing was changed.'); });
  if (!ss.getSheetByName(ACW.CONTROL)) { AC_controlLayout_(ss.insertSheet(ACW.CONTROL)); fixed.push('_Control re-created'); }
  if (!ss.getSheetByName(ACW.LOG)) { MV_logLayout_(ss.insertSheet(ACW.LOG)); fixed.push('_Load Log re-created'); }
  if (!ss.getSheetByName(ACW.FLAGS)) { MV_flagsLayout_(ss.insertSheet(ACW.FLAGS)); fixed.push('_Flags re-created'); }
  var m = AC_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  var ctl = ss.getSheetByName(ACW.CONTROL), ck = AC_checksumFormula_(m.cols, m.name);
  if (ctl.getRange(ACW.CHECKSUM_ROW, 2).getFormula() !== ck) {
    ctl.getRange(ACW.CHECKSUM_ROW, 1).setValue('Lookup checksum (changes when a Data Base edit changes a lookup; used by the dashboard)');
    ctl.getRange(ACW.CHECKSUM_ROW, 2).setFormula(ck);
    fixed.push('_Control checksum written');
  }
  [[ACW.CE, ACW.CE_TOTAL_COLS, AC_ceFormulas_(m.cols, m.name), ACW.CE_HEADERS], [ACW.RAW, ACW.RAW_TOTAL_COLS, AC_rawFormulas_(m.cols, m.name), ACW.RAW_HEADERS]].forEach(function (t) {
    var sh = ss.getSheetByName(t[0]), f = t[2], maxR = sh.getMaxRows();
    if (sh.getMaxColumns() < t[1]) sh.insertColumnsAfter(sh.getMaxColumns(), t[1] - sh.getMaxColumns());
    var first = sh.getRange(1, 1, 1, t[3].length).getValues()[0];
    if (first.some(function (x, i) { return String(x) !== t[3][i]; })) { sh.getRange(1, 1, 1, t[3].length).setValues([t[3]]); fixed.push(t[0] + ' headers written'); }
    var heads = sh.getRange(1, 1, 1, t[1]).getFormulas()[0], changed = [];
    Object.keys(f).forEach(function (col) {
      if (heads[MV_colNum_(col) - 1] === f[col]) return;
      if (maxR > 1) sh.getRange(col + '2:' + col + maxR).clearContent();
      sh.getRange(col + '1').setFormula(f[col]);
      changed.push(col);
    });
    if (changed.length) { fixed.push(t[0] + ': row-1 formulas written in ' + changed.join(',')); SpreadsheetApp.flush(); }
    var shown = sh.getRange(1, 1, 1, t[1]).getDisplayValues()[0];
    Object.keys(f).forEach(function (col) {
      if (String(shown[MV_colNum_(col) - 1]).indexOf('#REF') === 0 && maxR > 1) { sh.getRange(col + '2:' + col + maxR).clearContent(); fixed.push(t[0] + ' ' + col + ' cleared below row 1 (something was typed there)'); }
    });
  });
  return fixed;
}
function AC_controlLayout_(c) {
  c.getRange('A1:B1').setValues([['Status', 'Value']]).setFontWeight('bold');
  c.getRange('A2:A11').setValues([['Last Call Events load (Sisense)'], ['Call Events period'], ['Call Events status'], ['Rows in Call Events'], ['Last ACW load (NICE)'],
    ['ACW period'], ['ACW status'], ['Rows in ACW Raw Data'], ['Call Events loaded by'], ['ACW loaded by']]);
  c.getRange('A13').setValue('Settings').setFontWeight('bold');
  c.getRange('A14').setValue('Duplicate agent rows on the same day: KEEP (as Sisense returns them) or REMOVE (keep the first)');
  c.getRange('A15').setValue('ACW target, seconds per accepted call (Excel report: 10)');
  if (!String(c.getRange(ACW.DEDUPE_CELL).getValue() || '').trim()) c.getRange(ACW.DEDUPE_CELL).setValue('KEEP');
  if (!String(c.getRange(ACW.TARGET_CELL).getValue() || '').trim()) c.getRange(ACW.TARGET_CELL).setValue(ACW.DEFAULT_TARGET);
  c.setColumnWidth(1, 420);
}
function AC_dedupeSetting_(ss) {
  var c = ss.getSheetByName(ACW.CONTROL), v = c ? String(c.getRange(ACW.DEDUPE_CELL).getValue() || '').trim().toUpperCase() : '';
  return v === 'REMOVE' ? 'REMOVE' : 'KEEP';
}
function AC_target_(ss) {
  var c = ss.getSheetByName(ACW.CONTROL), v = c ? Number(c.getRange(ACW.TARGET_CELL).getValue()) : NaN;
  return isFinite(v) && v > 0 ? v : ACW.DEFAULT_TARGET;
}
function AC_checkReady_(ss) {
  if (ss.getSpreadsheetTimeZone() !== ACW.TZ) throw new Error('The ACW spreadsheet time zone reads ' + ss.getSpreadsheetTimeZone() + ' instead of ' + ACW.TZ + '. Run setupAcwSheet once (it sets it). Nothing was changed.');
  return AC_ensureFormulas_(ss);
}

/* ============================== CALL EVENTS (Sisense) ============================== */
function AC_backfillPlan_(today) { return MV_backfillPlan_(today); }

function acwBackfillSisense() {
  var who = MV_requireRun_();
  var plan = AC_backfillPlan_(AC_today_());
  return AC_runSisense_(plan.from, plan.to, who, 'Backfill (last ' + ACW.BACKFILL_DAYS + ' days)');
}
function acwLoadSisenseRange(from, to) {
  MV_requireRangeAccess_();
  var who = MV_email_();
  from = MV_ymd_(from); to = MV_ymd_(to);
  if (!from || !to) throw new Error('Give the From and To dates (yyyy-MM-dd).');
  if (from > to) throw new Error('The From date is after the To date.');
  if (to > MV_addDays_(AC_today_(), -1)) throw new Error('Reports are updated only up to yesterday (' + MV_addDays_(AC_today_(), -1) + ').');
  if (MV_days_n_(from, to) > ACW.MAX_DAYS) throw new Error('Pick at most ' + ACW.MAX_DAYS + ' days at a time.');
  return AC_runSisense_(from, to, who, 'Range');
}

/** Editor-friendly: no arguments. Loads Call Events from the 1st of the month up to yesterday (on the 1st it loads the whole previous month). Run it from the editor's Run button. */
function acwLoadMonthToDate() {
  var to = MV_addDays_(AC_today_(), -1), from = to.slice(0, 8) + '01';
  return acwLoadSisenseRange(from, to);
}

/** The widget "Calls Event by Vendor Log" (same JAQL as MVCC: Role = Interpreter + Operator, Status = Active + Terminated - Eligible) for [from,to], day by day. */
/* ---------- run lock (one ACW load at a time). Cache based: a stopped or timed-out run frees it after RUN_FLAG_TTL seconds. ---------- */
function AC_lockTake_(who, what) {
  var cache = CacheService.getScriptCache(), cur = cache.get(ACW.RUN_FLAG);
  if (cur) {
    var o = {}; try { o = JSON.parse(cur); } catch (e) { o = { who: cur }; }
    var since = o.at ? Utilities.formatDate(new Date(o.at), ACW.TZ, 'HH:mm') : '', free = o.at ? Utilities.formatDate(new Date(o.at + ACW.RUN_FLAG_TTL * 1000), ACW.TZ, 'HH:mm') : '';
    throw new Error('Another ACW load is running right now' + (o.what ? ' (' + o.what + (o.who ? ', started by ' + o.who : '') + (since ? ' at ' + since : '') + ')' : '') +
      '. Wait for it to finish (Apps Script > Executions shows it).' + (free ? ' If it was stopped, the lock clears by itself at ' + free + ', or the owner can run acwClearRunLock().' : ''));
  }
  cache.put(ACW.RUN_FLAG, JSON.stringify({ who: who || '', what: what || '', at: Date.now() }), ACW.RUN_FLAG_TTL);
}
function AC_lockFree_() { CacheService.getScriptCache().remove(ACW.RUN_FLAG); }
/** Editor: frees the ACW run lock left by a run that was stopped or timed out. Check Apps Script > Executions first: nothing ACW should be "Running". */
function acwClearRunLock() {
  requireSetupAccess_();
  var had = CacheService.getScriptCache().get(ACW.RUN_FLAG);
  AC_lockFree_();
  return MV_say_(had ? 'ACW run lock cleared (was: ' + had + ').' : 'There was no ACW run lock.');
}

/**
 * Sisense "Calls Event" rows for each day, fetched in parallel (UrlFetchApp.fetchAll, SIS_PARALLEL at a time).
 * Any answer that is not a clean 200 + data (expired token, a busy server) is retried once through MV_jaql_, the proven
 * single-call path that re-logs in and turns real errors into clear messages. Stops between batches when the time budget is used.
 */
function AC_sisenseDays_(days, t0) {
  var out = {}, n = ACW.SIS_PARALLEL, token = MV_token_();
  for (var i = 0; i < days.length; i += n) {
    if (i > 0 && Date.now() - t0 > ACW.RUN_BUDGET_MS) return { rows: out, stoppedAt: days[i] };
    var chunk = days.slice(i, i + n), bodies = chunk.map(function (d) { return MV_body_('A', d); });
    var res = UrlFetchApp.fetchAll(bodies.map(function (b) {
      return { url: MVCC.SIS_HOST + '/api/datasources/' + encodeURIComponent(b.datasource.fullname) + '/jaql', method: 'post', contentType: 'application/json',
               headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(b), muteHttpExceptions: true };
    }));
    var retried = false;
    res.forEach(function (r, k) {
      var j = null;
      var code = r.getResponseCode();
      if (code === 200) { try { j = JSON.parse(r.getContentText()); } catch (e) { j = null; } }
      if (code === 401 && !retried) CacheService.getScriptCache().remove(MVCC.SIS_TOKEN_KEY);   // expired token: log in again once
      if (!j || !j.headers || !j.values) { j = MV_jaql_(bodies[k]); retried = true; }
      out[chunk[k]] = MV_objects_(j);
    });
    if (retried) token = MV_token_();                                       // MV_jaql_ may have logged in again
  }
  return { rows: out, stoppedAt: '' };
}

function AC_runSisense_(from, to, who, mode) {
  var t0 = Date.now();
  AC_lockTake_(who, 'Call Events from Sisense, ' + from + ' to ' + to);
  var ss = null;
  try {
    ss = AC_ss_();
    AC_checkReady_(ss);
    var dedupe = AC_dedupeSetting_(ss), m = AC_dbColumns_(ss), roster = AC_loadRoster_(ss, m), alias = AC_aliasMap_(ss);
    var days = MV_dayList_(from, to), fetched = [], untouched = [];
    var got = AC_sisenseDays_(days, t0), stoppedAt = got.stoppedAt;
    days.forEach(function (d) {
      if (!got.rows.hasOwnProperty(d)) return;                            // not reached (time budget): continueFrom says where to go on
      if (!got.rows[d].length) untouched.push(d); else fetched.push({ day: d, rows: got.rows[d] });
    });
    var data = [], flags = [], perDay = [], processed = {}, learned = [];
    fetched.forEach(function (f) {
      var a = AC_buildCe_(f.rows, f.day, roster.resolve, alias, dedupe);
      data = data.concat(a.rows); flags = flags.concat(a.flags); processed[f.day] = 1;
      a.learned.forEach(function (x) { learned.push(x); alias[x[0].toLowerCase()] = x[1].toLowerCase(); });
      perDay.push({ day: f.day, rows: a.rows.length, notInDatabase: a.skipped, duplicates: a.dupes });
    });
    if (!fetched.length) {
      AC_log_(ss, [new Date(), who, from, to, mode, 'Call Events', 0, 0, Math.round((Date.now() - t0) / 1000), 'CHECK', 'Sisense returned no data for ' + untouched.join(', ') + '. Nothing was changed.']);
      return { ok: true, from: from, to: to, mode: mode, processed: [], untouched: untouched, perDay: [], status: 'CHECK',
               warnings: ['Sisense returned no data for ' + untouched.join(', ') + '. Nothing was changed.'], continueFrom: stoppedAt || '' };
    }
    var newAliases = AC_saveAliases_(ss, learned, AC_today_());             // before the rows: the formulas find the new names at once
    var sh = ss.getSheetByName(ACW.CE);
    var stats = MV_replaceDates_(sh, ACW.CE_LOAD_COLS, 1, data, processed, AC_keep_);
    SpreadsheetApp.flush();
    AC_replaceFlags_(ss, flags, processed, false);
    var chk = AC_postCheck_(ss, ACW.CE, 11, 3, processed);
    var secs = Math.round((Date.now() - t0) / 1000), warn = [];
    if (chk.errorRows) warn.push(chk.errorRows + ' Call Events rows show #N/A in the lookup columns (' + chk.errorAgents.slice(0, 5).join(', ') + ').');
    if (untouched.length) warn.push('No data yet in Sisense for ' + untouched.join(', ') + ' (left unchanged).');
    var skipped = perDay.reduce(function (s, p) { return s + p.notInDatabase; }, 0), dupTotal = perDay.reduce(function (s, p) { return s + p.duplicates; }, 0);
    if (skipped) warn.push(skipped + ' agent-day rows are not in the Data Base and were not written (see _Flags).');
    if (dupTotal) warn.push(dupTotal + ' duplicate agent-day rows ' + (dedupe === 'REMOVE' ? 'were reduced to one' : 'were kept (counted twice, like the Excel report)') + ' (see _Flags).');
    if (newAliases) warn.push(newAliases + ' name spelling(s) matched and saved in the Aliases tab.');
    var status = (chk.errorRows || untouched.length) ? 'CHECK' : 'OK';
    AC_log_(ss, [new Date(), who, from, to, mode, 'Call Events', data.length, flags.length, secs, status, warn.join(' ')]);
    AC_control_(ss, { B2: new Date(), B3: from + ' → ' + (stoppedAt ? MV_addDays_(stoppedAt, -1) : to), B4: status + (warn.length ? ': ' + warn.join(' ') : ''), B5: stats.total, B10: who });
    return { ok: true, from: from, to: to, mode: mode, processed: Object.keys(processed).sort(), untouched: untouched, perDay: perDay,
             totals: { rows: data.length, flags: flags.length, aliasesAdded: newAliases }, sheetRows: stats.total, status: status, warnings: warn, continueFrom: stoppedAt || '', seconds: secs };
  } catch (e) {
    try { AC_log_(ss || AC_ss_(), [new Date(), who, from, to, mode, 'Call Events', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    AC_lockFree_();
  }
}
function AC_keep_(v) { return { ord: 0 }; }

/* ============================== ACW (NICE) ============================== */
function acwStartNice() {
  var who = MV_requireRun_();
  AC_ss_();
  var plan = MV_paidPlan_(AC_today_());
  var runId = Utilities.getUuid();
  plan.runId = runId; plan.by = who;
  CacheService.getScriptCache().put('ACW_RUN_' + runId, JSON.stringify(plan), ACW.RUN_TTL);
  return { ok: true, runId: runId, from: plan.from, to: plan.to, days: plan.days, label: plan.label, jobs: [AC_niceJob_(plan)] };
}

/**
 * Time Utilization report, MU set "6 FG", Data = Agent Activity, details by day + agent + activity, activity code ACW only.
 * Built from the validated MVCC job (same report form, same view) with the code list reduced to ACW. Pure.
 */
function AC_niceJob_(plan) {
  var job = MV_niceJob_(plan, false);
  job.report = 'ACW Report (Agent Activity - ACW)';
  job.steps = job.steps.map(function (s) {
    if (s && s.op === 'set' && s.name === 'activityCodes') {
      var c = ACW.NICE_ACW_CODE;
      return { op: 'set', name: 'activityCodes', value: JSON.stringify([{ id: c.id, oid: c.oid, operator: 'NONE', hours: '0', minutes: '0' }]) };
    }
    if (s && s[0] === 'reportName') return ['reportName', 'ACW Report - Agent Activity (ACW)'];
    return s;
  });
  return job;
}

/** The page passes the CSV the extension downloaded. */
function acwSaveNice(runId, csv, meta) {
  var who = MV_requireRun_(), t0 = Date.now();
  AC_lockTake_(who, 'ACW from NICE');
  var plan;
  try { plan = AC_takePlan_(runId); } catch (e) { AC_lockFree_(); throw e; }
  meta = meta || {};
  var ss = null;
  try {
    ss = AC_ss_();
    AC_checkReady_(ss);
    var parsed = MV_paidRows_(csv, plan.from, plan.to, 'Agent Activity');
    var roster = AC_loadRoster_(ss);
    var built = AC_buildRaw_(parsed.rows, roster.byNice);
    if (!built.rows.length) throw new Error('NICE returned no ACW rows for ' + plan.label + ' that match the Data Base. Nothing was changed.');
    var days = {};
    MV_dayList_(plan.from, plan.to).forEach(function (d) { days[d] = 1; });             // the whole period is replaced (MTD)
    var sh = ss.getSheetByName(ACW.RAW);
    var stats = MV_replaceDates_(sh, ACW.RAW_LOAD_COLS, 1, built.rows, days, AC_keep_);
    AC_formatRaw_(sh, stats.total);
    SpreadsheetApp.flush();
    AC_replaceFlags_(ss, built.flags, days, true);
    var chk = AC_postCheck_(ss, ACW.RAW, 10, 4, days);
    var secs = Math.round((Date.now() - t0) / 1000);
    var mins = built.rows.reduce(function (s, r) { return s + Math.round(Number(r.v[6]) * 1440); }, 0);
    var warn = [];
    if (chk.errorRows) warn.push(chk.errorRows + ' ACW rows show #N/A in the lookup columns.');
    if (built.missing) warn.push(built.missing + ' agent-day(s) are not in the Data Base and were not written (see _Flags).');
    if (built.ignored) warn.push(built.ignored + ' NICE rows with another activity were ignored.');
    var status = chk.errorRows ? 'CHECK' : 'OK';
    AC_log_(ss, [new Date(), who, plan.from, plan.to, 'ACW (NICE)', 'ACW Raw Data', built.rows.length, built.flags.length, secs + (meta.niceSeconds ? ' (+' + meta.niceSeconds + ' in NICE)' : ''), status,
      built.rows.length + ' rows, ' + Math.round(mins / 6) / 10 + ' h ACW.' + (warn.length ? ' ' + warn.join(' ') : '') + (meta.reportOid ? ' NICE report ' + meta.reportOid + '.' : '')]);
    AC_control_(ss, { B6: new Date(), B7: plan.label + ' (' + plan.from + ' → ' + plan.to + ')', B8: status + (warn.length ? ': ' + warn.join(' ') : ''), B9: stats.total, B11: who });
    return { ok: true, from: plan.from, to: plan.to, label: plan.label, rows: built.rows.length, hours: Math.round(mins / 6) / 10, notInDatabase: built.missing, ignored: built.ignored,
             kept: stats.kept, total: stats.total, status: status, warnings: warn, seconds: secs };
  } catch (e) {
    try { AC_log_(ss || AC_ss_(), [new Date(), who, plan.from, plan.to, 'ACW (NICE)', 'ACW Raw Data', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    AC_lockFree_();
  }
}
function acwReportRunFailure(runId, stage, message) {
  var who = MV_requireRun_();
  var plan = null;
  try { var raw = CacheService.getScriptCache().get('ACW_RUN_' + String(runId || '')); plan = raw ? JSON.parse(raw) : null; } catch (ignore) {}
  try {
    AC_log_(AC_ss_(), [new Date(), who, plan ? plan.from : '', plan ? plan.to : '', 'ACW (NICE)', 'ACW Raw Data', '', '', '', 'FAILED',
      (stage ? '[' + String(stage).slice(0, 60) + '] ' : '') + String(message || '').slice(0, 500)]);
  } catch (ignore) {}
  return { ok: true };
}
function AC_formatRaw_(sh, total) {
  try {
    var n = Math.max(0, total - 0);
    if (n < 1) return;
    sh.getRange(2, 7, n, 1).setNumberFormat('[h]:mm');
    sh.getRange(2, 8, n, 1).setNumberFormat('0.00%');
  } catch (ignore) {}
}

/* ============================== CHECKS / CONTROL / LOG / FLAGS ============================== */
/** After a load: do the lookup columns resolve for the loaded days? errCol = 1-based column of a lookup result, nameCol = the agent name column. */
function AC_postCheck_(ss, tab, errCol, nameCol, days) {
  var sh = ss.getSheetByName(tab), last = MV_lastRow_(sh, 1), errorRows = 0, agents = {};
  if (last < 2) return { errorRows: 0, errorAgents: [] };
  var a = sh.getRange(2, 1, last - 1, 1).getValues(), nm = sh.getRange(2, nameCol, last - 1, 1).getValues(), r = sh.getRange(2, errCol, last - 1, 1).getDisplayValues();
  for (var i = 0; i < a.length; i++) {
    var day = MV_ymdOf_(a[i][0]);
    if (!day || !days[day]) continue;
    if (/^#/.test(String(r[i][0]))) { errorRows++; agents[nm[i][0]] = 1; }
  }
  return { errorRows: errorRows, errorAgents: Object.keys(agents) };
}
function AC_control_(ss, map) { var c = ss.getSheetByName(ACW.CONTROL); if (c) Object.keys(map).forEach(function (a1) { c.getRange(a1).setValue(map[a1]); }); }
function AC_log_(ss, row) { var l = ss.getSheetByName(ACW.LOG); if (l) l.appendRow(row.map(function (v) { return typeof v === 'string' ? MV_text_(v) : v; })); }
/** Replaces the flags of the processed days that belong to the same source (ACW_* types = NICE, the others = Sisense). */
function AC_replaceFlags_(ss, flags, days, acwFamily) {
  var f = ss.getSheetByName(ACW.FLAGS);
  if (!f) return;
  var last = f.getLastRow(), keep = [];
  if (last >= 2) f.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) {
    var d = MV_ymdOf_(r[0]) || String(r[0]), isAcw = /^ACW_/.test(String(r[1]));
    if (!(days[d] && isAcw === !!acwFamily)) keep.push(r);
  });
  var now = new Date();
  var all = keep.concat(flags.map(function (x) { return [x[0], x[1], MV_text_(x[2]), MV_text_(x[3]), now]; }));
  if (last >= 2) f.getRange(2, 1, last - 1, 5).clearContent();
  if (all.length) {
    if (f.getMaxRows() < all.length + 1) f.insertRowsAfter(f.getMaxRows(), all.length + 1 - f.getMaxRows());
    f.getRange(2, 1, all.length, 5).setValues(all);
  }
}
function AC_takePlan_(runId) {
  var c = CacheService.getScriptCache(), raw = c.get('ACW_RUN_' + String(runId || ''));
  if (!raw) throw new Error('This run expired or is unknown (runs are valid for 30 minutes). Start it again.');
  var plan = JSON.parse(raw);
  c.remove('ACW_RUN_' + runId);
  return plan;
}

/* ============================== SETUP / REPAIR / TESTS (editor) ============================== */
function setupAcwSheet() {
  requireSetupAccess_();
  var ss = AC_ss_();
  var tzNote = MV_fixTimeZone_(ss);
  if (!AC_dbSheet_(ss)) throw new Error('The "' + ACW.DB + '" tab is missing. The spreadsheet must be the "ACW Data" workbook with the Data Base tab (IMPORTRANGE of the Database workbook).');
  var made = [];
  [ACW.ALIAS, ACW.CE, ACW.RAW].forEach(function (n) { if (!ss.getSheetByName(n)) { ss.insertSheet(n); made.push(n); } });
  var al = ss.getSheetByName(ACW.ALIAS);
  if (!String(al.getRange('A1').getValue() || '')) al.getRange('A1:C1').setValues([['Name in Sisense', 'Name in the Data Base (Interpreter name)', 'Note']]).setFontWeight('bold');
  var c = ss.getSheetByName(ACW.CONTROL) || ss.insertSheet(ACW.CONTROL);
  AC_controlLayout_(c);
  var l = ss.getSheetByName(ACW.LOG) || ss.insertSheet(ACW.LOG);
  if (!l.getRange('A1').getValue()) l.getRange(1, 1, 1, 11).setValues([['Run at', 'By', 'From', 'To', 'Mode', 'Tab', 'Rows', 'Flags', 'Seconds', 'Status', 'Message']]).setFontWeight('bold');
  var f = ss.getSheetByName(ACW.FLAGS) || ss.insertSheet(ACW.FLAGS);
  if (!f.getRange('A1').getValue()) MV_flagsLayout_(f);
  var m = AC_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  var fixed = AC_ensureFormulas_(ss);
  return MV_say_('ACW sheet is ready in "' + ss.getName() + '". ' + tzNote + (made.length ? ' Tabs created: ' + made.join(', ') + '.' : '') + ' Data Base columns found: ' +
    Object.keys(m.cols).map(function (k) { return ACW.DB_COLS[k] + '=' + m.cols[k]; }).join(', ') + '.' + (fixed.length ? ' ' + fixed.join('; ') + '.' : ''));
}
function repairAcwFormulas() {
  requireSetupAccess_();
  var ss = AC_ss_(), r = AC_ensureFormulas_(ss);
  var desc = 'ACW formula columns (one formula in row 1) - do not type here';
  [[ACW.CE, 'K:U'], [ACW.RAW, 'I:P']].forEach(function (t) {
    try {
      var sh = ss.getSheetByName(t[0]);
      var has = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) { return p.getDescription() === desc; });
      if (!has) { sh.getRange(t[1]).protect().setDescription(desc).setWarningOnly(true); r.push(t[0] + ': typing warning added on ' + t[1]); }
    } catch (ignore) {}
  });
  return MV_say_(r.length ? 'Repaired: ' + r.join('; ') + '.' : 'Formulas OK.');
}
function acwCheckSetup() {
  requireSetupAccess_();
  var ss = AC_ss_(), lines = [];
  lines.push('Time zone: ' + ss.getSpreadsheetTimeZone() + (ss.getSpreadsheetTimeZone() === ACW.TZ ? ' (OK).' : ' (must be ' + ACW.TZ + ').'));
  var m = AC_dbColumns_(ss);
  lines.push(m.ok ? 'Data Base OK (' + AC_dbStatus_(ss, false).rows + ' rows).' : m.message);
  if (m.ok) {
    [[ACW.CE, ACW.CE_TOTAL_COLS, AC_ceFormulas_(m.cols, m.name)], [ACW.RAW, ACW.RAW_TOTAL_COLS, AC_rawFormulas_(m.cols, m.name)]].forEach(function (t) {
      var sh = ss.getSheetByName(t[0]);
      if (!sh) { lines.push(t[0] + ' tab missing (run setupAcwSheet).'); return; }
      var heads = sh.getRange(1, 1, 1, t[1]).getFormulas()[0], diff = [];
      Object.keys(t[2]).forEach(function (c) { if (heads[MV_colNum_(c) - 1] !== t[2][c]) diff.push(c + '1'); });
      lines.push(t[0] + ': ' + (diff.length ? 'row-1 formulas missing or different in ' + diff.join(', ') + ' (run repairAcwFormulas).' : 'row-1 formulas OK.') + ' ' + Math.max(0, MV_lastRow_(sh, 1) - 1) + ' rows.');
    });
    var r = AC_loadRoster_(ss, m);
    lines.push('Roster: ' + r.people.length + ' agents, ' + r.issues.duplicateNiceIds.length + ' duplicate Nice IDs, ' + r.issues.swappedNames.length + ' rows with First/Last name swapped, ' + r.issues.textDates + ' text dates.');
  }
  lines.push('Duplicate setting: ' + AC_dedupeSetting_(ss) + '. Target: ' + AC_target_(ss) + ' s.');
  return MV_say_(lines.join(' '));
}
/** Rollback path: saves a dated copy of the whole ACW workbook in the owner's Drive (same folder as the original). Run it before the first load and whenever you want a restore point. */
function acwBackupSheet() {
  requireSetupAccess_();
  var ss = AC_ss_(), stamp = Utilities.formatDate(new Date(), ACW.TZ, 'yyyy-MM-dd');
  var name = ss.getName() + ' - backup ' + stamp + ' ' + Utilities.formatDate(new Date(), ACW.TZ, 'HH:mm');
  var file = DriveApp.getFileById(ss.getId()), copy = file.makeCopy(name);
  return MV_say_('Backup saved: "' + name + '" (' + copy.getUrl() + '). To roll back, copy the tabs you need from it, or use File > Version history in the live workbook.');
}
function TEST_acwSisenseProbe(day) {
  requireSetupAccess_();
  var ymd = day ? MV_ymd_(day) : MV_addDays_(AC_today_(), -1);
  CacheService.getScriptCache().remove(MVCC.SIS_TOKEN_KEY);
  var rows = MV_objects_(MV_jaql_(MV_body_('A', ymd)));
  var msg = 'Sisense OK for ' + ymd + ': Calls Event widget ' + rows.length + ' rows.';
  Logger.log(msg); Logger.log('First row: ' + JSON.stringify(rows[0] || null));
  return msg;
}

/* ============================== HELPERS ============================== */
function AC_ss_() {
  var id = PropertiesService.getScriptProperties().getProperty(ACW.PROP_ID);
  if (!id) throw new Error('The ACW spreadsheet is not set up yet (Script Property ' + ACW.PROP_ID + ' is missing). Ask the app owner.');
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw new Error('You do not have access to the ACW Data spreadsheet. Ask the owner to share it with you (Editor to run the automation).'); }
}
function AC_today_() { return Utilities.formatDate(new Date(), ACW.TZ, 'yyyy-MM-dd'); }
