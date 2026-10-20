/**
 * Adherence.gs — NEW FILE (changes no existing file).
 * -----------------------------------------------------------------------------
 * NICE WFM "Adherence" report → the "Adherence Data" spreadsheet → Adherence dashboard.
 *
 * How a run works (no triggers, started by a person):
 *   1. A teammate clicks "Start Automation" on the Adherence dashboard.
 *   2. adhStartRun() decides the period (1st of this month → yesterday, New York time; on the 1st it
 *      refuses: there is no complete day yet) and returns the NICE steps for that period.
 *   3. The "WFM NICE Connector" Chrome extension runs those steps in the teammate's own, already
 *      signed-in NICE WebStation (background tab): Generate → wait → download CSV.
 *   4. adhSaveReport(runId, csv) checks the CSV and replaces those dates in "Raw Data" (A:O).
 *   5. Columns P:W are ONE array formula per column in row 1 (header + all rows), looking the
 *      agent up in "Database" (an IMPORTRANGE of the Roster Database). The loader never writes P:W;
 *      it re-checks and rewrites the row-1 formulas on every run (self-repair) and finds the Database
 *      columns by their header names, so a moved column in the source does not break the lookups.
 *
 * Spreadsheet tabs: Raw Data (A:O loaded + P:W formulas), Database (IMPORTRANGE in A1),
 *                   _Control (status + settings), _Load Log (one line per run, also failed runs).
 * Raw Data A:W keeps the workbook's exact column order and headers.
 *
 * Public entry points (all guarded):
 *   setupAdherenceSheet()            editor, once / any time   requireSetupAccess_
 *   repairAdherenceFormulas()        editor, any time          requireSetupAccess_
 *   adhCheckSetup()                  editor, read-only check   requireSetupAccess_
 *   adhStartRun()                    app (Start Automation)    run roles (ADH.RUN_ROLES)
 *   adhSaveReport(runId, csv, meta)  app (after the download)  run roles
 *   adhReportRunFailure(runId, ...)  app (run failed)          run roles
 *
 * Depends on (existing): requireRegistered_(), requireSetupAccess_(), dashRole_() (Dashboards.gs).
 * Script Property: ADH_SPREADSHEET_ID (setupAdherenceSheet creates the spreadsheet and saves it on the first run).
 * No ScriptApp, no new OAuth scope.
 */

var ADH = {
  TZ: 'America/New_York',
  PROP_ID: 'ADH_SPREADSHEET_ID',
  NEW_NAME: 'Adherence Data',               // name used when setupAdherenceSheet creates the spreadsheet
  SHEET: 'Raw Data',
  DB: 'Database',
  CONTROL: '_Control',
  LOG: '_Load Log',
  RUN_ROLES: ['RTM', 'Manager', 'Admin'],          // who may press Start Automation (owner: "any authorized teammate")
  RUN_FLAG: 'ADH_RUNNING',
  RUN_TTL: 1800,                                   // seconds a started run stays valid
  MAX_DAYS: 31,
  MAX_ROWS: 400000,
  WRITE_CHUNK: 20000,

  // Roster Database (IMPORTRANGE source). Editable later in _Control B11:B13 (the next run uses them).
  DB_URL: 'https://docs.google.com/spreadsheets/d/1SIf7azXN50pp5EcO-otDwM7AQnSAqV1J_CbFSIeWFJQ/edit?gid=0#gid=0',
  DB_TAB: "Database Oct'26",
  DB_RANGE: 'A1:AG',                               // open-ended (the owner's formula said A1:AG306; new hires below row 306 are kept)

  // NICE CSV ("Adherence", details by agent and day): exact header row, 15 columns → Raw Data A:O.
  CSV_HEADERS: ['Date', 'Entity ID', 'Entity Name', 'Agent ID', 'Agent Name', 'Scheduled Activities',
    'Scheduled Time', 'Actual Time', 'Min. in Adherence', 'Min. out Adherence', 'Percent in Adherence',
    '+/- Min. in Conformance', 'Percent in Conformance', 'Percent of Total Schedule', 'Percent of Total Actual'],
  LOAD_COLS: 15,                                   // A:O
  FORMULA_HEADERS: ['Name on Community', 'Language', 'Language Group', 'Supervisor', 'Queue',
    'Scheduled Time Min', 'Platform', 'SDACMs'],   // P:W (the workbook's names)
  TOTAL_COLS: 23,                                  // A:W
  MISSING: 'Not in Database',

  // Database columns used by the lookups, found by header name (row 1 of the Database tab).
  DB_COLS: { id: 'Nice ID', name: 'Name on Nice', seatLang: 'Seat Language', lg: 'Language Group',
             sup: 'Supervisor', platform: 'Main Platform', manager: 'Manager' }
};

/* ============================== NICE STEPS (one workflow per report) ============================== */
/**
 * The Adherence report exactly as the owner runs it (2026-10-08):
 *   Report type CSV · Report by: MU set "6 FG" · Absolute dates · 1st of the month → yesterday ·
 *   Include details by day + details by agent · sorted by agent name · On demand.
 * The extension runs these steps in the NICE page; nothing here depends on the screen layout.
 */
function ADH_niceJob_(plan) {
  return {
    workflow: 'nice-report',
    report: 'Adherence',
    shellPath: '/wfm/supervisor/reports-generate',
    formUrl: '/supv/reportAction.mvc?selectedTabAction=/AdherenceReportMain.mvc&selectedTabOverride=/generateReportWizard.mvc',
    listUrl: '/supv/reportAction.mvc?selectedTabAction=/showReportList.mvc?lang=en_US&langFileName=en',
    formName: 'AdherenceReportForm',
    fields: [
      ['reportName', 'Adherance Report'],
      ['reportFormatTypeOid', 'CSV'],
      ['reportTypeParam', 'MU_SET', 900],         // Report by: MU set (NICE redraws the form)
      ['viewIdParam', '6', 300],
      ['viewNameParam', 'FG', 300],
      ['isAbsolute', 'true', 300],
      ['stAbsDate', plan.niceFrom],
      ['endAbsDate', plan.niceTo],
      ['inclDetailsPerDay', true],
      ['inclDetailsPerAgent', true],
      ['inclSummaries', false],
      ['inclChart', false],
      ['isAgent', 'true'],
      ['@sort', 'ASC_AGENT_NAME'],                 // NICE requires at least one sort option
      ['isOnDemand', 'true', 300]
    ],
    verify: ['reportFormatTypeOid', 'reportTypeParam', 'viewIdParam', 'viewNameParam', 'isAbsolute', 'stAbsDate',
             'endAbsDate', 'inclDetailsPerDay', 'inclDetailsPerAgent', 'selectedSortOptions', 'isOnDemand'],
    match: { name: 'Adherence', subject: '6 FG', start: plan.niceFrom, end: plan.niceTo },
    expectHeader: 'Date,Entity ID,Entity Name,Agent ID',
    timeoutSec: 420
  };
}

/* ============================== RUN (app) ============================== */
/** Start Automation: returns the period and the NICE steps, or a plain message when there is nothing to run. */
function adhStartRun() {
  var who = ADH_requireRun_();
  ADH_ss_();                                                          // fails early with a clear message when not set up
  var plan = ADH_plan_(ADH_today_());
  if (!plan.ok) return plan;
  var runId = Utilities.getUuid();
  plan.runId = runId;
  plan.by = who;
  plan.startedAt = new Date().getTime();
  CacheService.getScriptCache().put('ADH_RUN_' + runId, JSON.stringify(plan), ADH.RUN_TTL);
  return { ok: true, runId: runId, from: plan.from, to: plan.to, days: plan.days, label: plan.label, job: ADH_niceJob_(plan) };
}

/** Period rule (owner, 2026-10-08): 1st of the current month through yesterday; on the 1st: nothing to run. Pure. */
function ADH_plan_(today) {
  var p = today.split('-').map(Number);
  if (p[2] === 1) {
    return { ok: false, code: 'FIRST_DAY', message: 'Today is the 1st: there is no complete day of ' + ADH_monthName_(p[1]) +
      ' yet. The first run of the month is possible from tomorrow (it will load the 1st).' };
  }
  var from = today.slice(0, 8) + '01', to = ADH_addDays_(today, -1);
  return { ok: true, from: from, to: to, days: ADH_days_(from, to), niceFrom: ADH_niceDate_(from), niceTo: ADH_niceDate_(to),
           label: ADH_label_(from, to) };
}

/**
 * Called by the page with the CSV the extension downloaded. Checks it against the run's plan, replaces
 * those dates in Raw Data, repairs the formulas and returns a summary (rows, days, lookup misses, checks).
 */
function adhSaveReport(runId, csv, meta) {
  var who = ADH_requireRun_(), t0 = Date.now();
  var plan = ADH_takePlan_(runId);
  meta = meta || {};
  var cache = CacheService.getScriptCache();
  if (cache.get(ADH.RUN_FLAG)) throw new Error('Another Adherence load is being saved right now. Wait a minute and press Start Automation again.');
  cache.put(ADH.RUN_FLAG, who, 300);
  try {
    var parsed = ADH_parseCsv_(csv);
    var rows = ADH_rowsFromCsv_(parsed, plan.from, plan.to);
    if (!rows.length) throw new Error('NICE returned no rows for ' + plan.label + '. Nothing was changed.');
    var ss = ADH_ss_(), sh = ADH_sheet_(ss);
    var repair = ADH_ensureFormulas_(ss, sh);                  // Database import + formulas first: a setting problem stops the run before any row is written
    var stats = ADH_replaceDates_(sh, rows, plan.from, plan.to);
    SpreadsheetApp.flush();
    var check = ADH_postCheck_(ss, sh, rows);
    var secs = Math.round((Date.now() - t0) / 1000);
    var status = check.errors.length ? 'CHECK' : 'OK';
    var message = (check.errors.length ? check.errors.join(' ') + ' ' : '') + check.notes.join(' ') + (repair.length ? ' Repaired: ' + repair.join(', ') + '.' : '');
    ADH_log_(ss, [new Date(), who, plan.from, plan.to, 'Start Automation', rows.length, stats.kept, check.unmapped,
      secs + (meta.niceSeconds ? ' (+' + meta.niceSeconds + ' in NICE)' : ''), status, (meta.reportOid ? 'NICE report ' + meta.reportOid + '. ' : '') + message.trim()]);
    ADH_control_(ss, { B2: new Date(), B3: plan.label + ' (' + plan.from + ' → ' + plan.to + ')', B4: status + (message ? ': ' + message.trim() : ''),
                       B5: stats.total, B6: check.days, B7: check.unmapped, B8: who });
    try { if (typeof ADHD_warm_ === 'function') ADHD_warm_(); } catch (ignore) {}      // dashboard data ready for the next visitor
    return { ok: true, from: plan.from, to: plan.to, label: plan.label, rows: rows.length, kept: stats.kept, total: stats.total,
             days: check.days, agents: check.agents, unmapped: check.unmapped, unmappedAgents: check.unmappedAgents.slice(0, 20),
             status: status, message: message.trim(), seconds: secs };
  } catch (e) {
    try { ADH_log_(ADH_ss_(), [new Date(), who, plan.from, plan.to, 'Start Automation', '', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    cache.remove(ADH.RUN_FLAG);
  }
}

/** The page reports a run that failed before anything reached the sheet (NICE refused, timeout, login abandoned …). */
function adhReportRunFailure(runId, stage, message) {
  var who = ADH_requireRun_();
  var plan = null;
  try { var raw = CacheService.getScriptCache().get('ADH_RUN_' + String(runId || '')); plan = raw ? JSON.parse(raw) : null; } catch (ignore) {}
  var text = String(message || '').slice(0, 500), st = String(stage || '').slice(0, 60);
  try {
    ADH_log_(ADH_ss_(), [new Date(), who, plan ? plan.from : '', plan ? plan.to : '', 'Start Automation', '', '', '', '', 'FAILED', (st ? '[' + st + '] ' : '') + text]);
  } catch (ignore) {}
  return { ok: true };
}

/* ============================== SETUP / REPAIR (editor) ============================== */
/** Creates or repairs every tab, header, formula, format and protection. Safe to run again. */
function setupAdherenceSheet() {
  requireSetupAccess_();
  var props = PropertiesService.getScriptProperties(), created = false;
  if (!props.getProperty(ADH.PROP_ID)) {                    // first run: create the spreadsheet (New York time, US locale) and remember it
    var nss = SpreadsheetApp.create(ADH.NEW_NAME);
    nss.setSpreadsheetTimeZone(ADH.TZ);
    nss.setSpreadsheetLocale('en_US');
    props.setProperty(ADH.PROP_ID, nss.getId());
    created = true;
  }
  var ss = ADH_ss_();
  if (ss.getSpreadsheetTimeZone() !== ADH.TZ) {
    throw new Error('Set File > Settings > Time zone to (GMT-04:00/-05:00) Eastern Time - New York first. Current: ' + ss.getSpreadsheetTimeZone());
  }
  var c = ss.getSheetByName(ADH.CONTROL) || ss.insertSheet(ADH.CONTROL);
  ADH_controlLayout_(c);
  var db = ss.getSheetByName(ADH.DB) || ss.insertSheet(ADH.DB);
  ADH_dbFormula_(ss, db, c);
  var sh = ss.getSheetByName(ADH.SHEET) || ss.insertSheet(ADH.SHEET, 0);
  if (sh.getMaxColumns() < ADH.TOTAL_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), ADH.TOTAL_COLS - sh.getMaxColumns());
  if (sh.getMaxColumns() > ADH.TOTAL_COLS) sh.deleteColumns(ADH.TOTAL_COLS + 1, sh.getMaxColumns() - ADH.TOTAL_COLS);
  sh.getRange(1, 1, 1, ADH.LOAD_COLS).setValues([ADH.CSV_HEADERS]);
  sh.setFrozenRows(1);
  sh.getRange('A2:A').setNumberFormat('m/d/yyyy');
  sh.getRange('G2:H').setNumberFormat('[h]:mm');
  sh.getRange('K2:K').setNumberFormat('0.00%');
  sh.getRange('M2:O').setNumberFormat('0.00%');
  sh.getRange('B2:B').setNumberFormat('0');
  sh.getRange('D2:D').setNumberFormat('0');
  sh.getRange('U2:U').setNumberFormat('0');
  sh.getRange(1, 1, 1, ADH.TOTAL_COLS).setFontWeight('bold');
  sh.getRange('P1:W1').setBackground('#e8f0fe');
  var desc = 'Adherence formula columns P:W — do not type here';
  var exists = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) { return p.getDescription() === desc; });
  if (!exists) sh.getRange('P:W').protect().setDescription(desc).setWarningOnly(true);
  var log = ss.getSheetByName(ADH.LOG) || ss.insertSheet(ADH.LOG);
  if (!log.getRange('A1').getValue()) {
    log.getRange(1, 1, 1, 11).setValues([['Run at', 'By', 'From', 'To', 'Mode', 'Rows loaded', 'Rows kept from other dates',
      'Rows not in Database', 'Seconds', 'Status', 'Message']]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  if (created) {                                            // the empty default tab of a new spreadsheet
    ss.getSheets().forEach(function (s) {
      if ([ADH.SHEET, ADH.DB, ADH.CONTROL, ADH.LOG].indexOf(s.getName()) < 0 && s.getLastRow() === 0) ss.deleteSheet(s);
    });
  }
  SpreadsheetApp.flush();
  var repair = ADH_ensureFormulas_(ss, sh);
  var st = ADH_dbStatus_(ss, true);
  return ADH_say_((created ? 'Created "' + ss.getName() + '": ' + ss.getUrl() + ' (Script Property ' + ADH.PROP_ID + ' saved). ' : '') +
    'Adherence sheet is ready in "' + ss.getName() + '". ' + st.message + (repair.length ? ' ' + repair.join(', ') + '.' : ''));
}

function repairAdherenceFormulas() {
  requireSetupAccess_();
  var ss = ADH_ss_(), r = ADH_ensureFormulas_(ss, ADH_sheet_(ss));
  return ADH_say_(r.length ? 'Repaired: ' + r.join(', ') : 'Formulas OK.');
}

/** Read-only health check for the editor: database import, formulas, row counts, formula-vs-recalculation agreement. */
function adhCheckSetup() {
  requireSetupAccess_();
  var ss = ADH_ss_(), sh = ADH_sheet_(ss), st = ADH_dbStatus_(ss, true);
  var last = ADH_lastRow_(sh), lines = [st.message, 'Raw Data rows: ' + Math.max(0, last - 1) + '.'];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, ADH.TOTAL_COLS).getValues();
    var v = ADH_verifyLookups_(vals, ADH_dbTable_(ss));
    lines.push('Formula check: ' + v.checked + ' rows compared with the Database, ' + v.mismatch + ' differences' +
      (v.examples.length ? ' (e.g. ' + v.examples.join('; ') + ')' : '') + '.');
  }
  return ADH_say_(lines.join(' '));
}

/* ============================== FORMULAS (P:W, row 1) ============================== */
/**
 * One array formula per column. Lookup key = Agent ID (D) ↔ Database "Nice ID", both compared as text (&"").
 * The Database letters come from its header row, so they follow the source if its columns move.
 */
function ADH_formulas_(m) {
  var key = 'D2:D&""', rng = function (col) { return 'Database!$' + col + '$2:$' + col; };
  var look = function (header, col) {
    return '=ARRAYFORMULA({"' + header + '";IF(D2:D="",,IFNA(VLOOKUP(' + key + ',{' + rng(m.id) + '&"",' + rng(col) + '},2,FALSE),"' + ADH.MISSING + '"))})';
  };
  return {
    P: look('Name on Community', m.name),
    Q: look('Language', m.seatLang),                // the workbook's "Language" is the Seat Language
    R: look('Language Group', m.lg),
    S: look('Supervisor', m.sup),
    T: '=ARRAYFORMULA({"Queue";IF(D2:D="",,IFNA(IF(VLOOKUP(' + key + ',{' + rng(m.id) + '&"",' + rng(m.lg) + '},2,FALSE)="PENs","Operator","VRI"),"' + ADH.MISSING + '"))})',
    U: '=ARRAYFORMULA({"Scheduled Time Min";IF(D2:D="",,ROUND(G2:G*1440,0))})',
    V: look('Platform', m.platform),
    W: look('SDACMs', m.manager)                    // SDACMs = the Database "Manager" (owner, 2026-10-08)
  };
}

/** Self-repair: Database!A1 import formula + every P:W row-1 formula. Returns what was rewritten. */
function ADH_ensureFormulas_(ss, sh) {
  var fixed = [], c = ss.getSheetByName(ADH.CONTROL), db = ss.getSheetByName(ADH.DB);
  if (!c) { c = ss.insertSheet(ADH.CONTROL); ADH_controlLayout_(c); fixed.push('_Control rebuilt'); }
  if (!db) { db = ss.insertSheet(ADH.DB); fixed.push('Database tab re-created'); }
  var previous = db.getRange('A1').getFormula();
  var changed = ADH_dbFormula_(ss, db, c);
  if (changed) { SpreadsheetApp.flush(); fixed.push('Database!A1 import rewritten'); }
  var m = ADH_dbColumns_(ss);
  if (!m.ok) {
    if (changed && previous) {                             // the new settings do not work: go back to the import that did
      db.getRange(1, 1, db.getMaxRows(), db.getMaxColumns()).clearContent();
      db.getRange('A1').setFormula(previous);
      SpreadsheetApp.flush();
      if (ADH_dbColumns_(ss).ok) throw new Error(m.message + ' The previous Database import was restored, so the dashboard keeps working; fix _Control B11:B13 and run again.');
    }
    throw new Error(m.message);
  }
  var f = ADH_formulas_(m.cols), maxR = sh.getMaxRows();
  Object.keys(f).forEach(function (col) {
    var cell = sh.getRange(col + '1');
    if (cell.getFormula() !== f[col]) { cell.setFormula(f[col]); fixed.push(col + '1 rewritten'); }
  });
  SpreadsheetApp.flush();
  Object.keys(f).forEach(function (col) {                 // #REF! in row 1 = something typed in the spill area: clear it
    if (String(sh.getRange(col + '1').getDisplayValue()).indexOf('#REF') === 0 && maxR > 1) {
      sh.getRange(col + '2:' + col + maxR).clearContent();
      fixed.push(col + ' spill area cleared');
    }
  });
  return fixed;
}

/** Database!A1 = IMPORTRANGE(url, 'tab'!range) from _Control B11:B13. Returns true when it had to be (re)written. */
function ADH_dbFormula_(ss, db, c) {
  var s = c.getRange('B11:B13').getValues();
  var url = String(s[0][0] || ADH.DB_URL).trim(), tab = String(s[1][0] || ADH.DB_TAB).trim(), range = String(s[2][0] || ADH.DB_RANGE).trim();
  if (!s[0][0] || !s[1][0] || !s[2][0]) c.getRange('B11:B13').setValues([[url], [tab], [range]]);
  var want = '=IMPORTRANGE("' + url.replace(/"/g, '') + '","\'' + tab.replace(/'/g, "''").replace(/"/g, '') + '\'!' + range.replace(/[^A-Za-z0-9:]/g, '') + '")';
  var cell = db.getRange('A1');
  if (cell.getFormula() === want) return false;
  db.getRange(1, 1, db.getMaxRows(), db.getMaxColumns()).clearContent();
  cell.setFormula(want);
  return true;
}

/** Finds the Database columns used by the formulas from its header row. */
function ADH_dbColumns_(ss) {
  var st = ADH_dbStatus_(ss, true);
  if (!st.ok) return { ok: false, message: st.message };
  var head = st.header, cols = {}, missing = [];
  Object.keys(ADH.DB_COLS).forEach(function (k) {
    var want = ADH_norm_(ADH.DB_COLS[k]), i = -1;
    for (var j = 0; j < head.length; j++) if (ADH_norm_(head[j]) === want) { i = j; break; }
    if (i < 0) missing.push(ADH.DB_COLS[k]); else cols[k] = ADH_col_(i + 1);
  });
  if (missing.length) return { ok: false, message: 'The Roster Database tab has no column named: ' + missing.join(', ') + '. Check _Control B12 (tab name) or the source sheet. Nothing was changed.' };
  return { ok: true, cols: cols };
}

/**
 * Is the IMPORTRANGE working? IMPORTRANGE can show "Loading…" for a few seconds, so this waits a little.
 * #REF! with "connect"/"permission" = the one-time "Allow access" click is still missing.
 */
function ADH_dbStatus_(ss, wait) {
  var db = ss.getSheetByName(ADH.DB);
  if (!db) return { ok: false, message: 'The Database tab is missing. Run setupAdherenceSheet().' };
  var tries = wait ? 8 : 1;
  for (var i = 0; i < tries; i++) {
    var head = db.getRange(1, 1, 1, Math.min(40, db.getMaxColumns())).getValues()[0];
    var a1 = String(db.getRange('A1').getDisplayValue() || '');
    if (/^#REF/i.test(a1) || /^#N\/A/i.test(a1) || /^#ERROR/i.test(a1)) {
      var note = '';
      try { note = String(db.getRange('A1').getNote() || ''); } catch (ignore) {}
      return { ok: false, message: 'The Database import is not working yet (' + a1 + '). Open the spreadsheet, click cell Database!A1 and press "Allow access" once ' +
        '(the person doing it needs view access to the Roster Database). Also check _Control B12 (source tab name). ' + note };
    }
    var nonEmpty = head.filter(function (h) { return String(h).trim() !== ''; }).length;
    if (nonEmpty >= 5) {
      var rows = db.getLastRow();
      return { ok: true, header: head.map(function (h) { return String(h); }), rows: Math.max(0, rows - 1),
               message: 'Database import OK (' + Math.max(0, rows - 1) + ' agents).' };
    }
    if (i < tries - 1) { Utilities.sleep(2500); SpreadsheetApp.flush(); }
  }
  return { ok: false, message: 'The Database import shows no data (still loading, or "Allow access" is needed on Database!A1).' };
}

/* ============================== CSV ============================== */
/** RFC-4180 CSV → { header, rows }. Strict: the 15 NICE headers in order (spaces/case ignored). Pure. */
function ADH_parseCsv_(text) {
  text = String(text === null || text === undefined ? '' : text).replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The NICE download was empty.');
  if (/^\s*</.test(text)) throw new Error('NICE returned a web page instead of the CSV (the session may have ended). Nothing was changed.');
  var out = [], row = [], f = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (q) {
      if (ch === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(f); out.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  out = out.filter(function (r) { return !(r.length === 1 && String(r[0]).trim() === ''); });
  if (!out.length) throw new Error('The NICE download had no header row.');
  var header = out[0].map(function (h) { return String(h).trim(); });
  var bad = [];
  ADH.CSV_HEADERS.forEach(function (h, k) { if (ADH_norm_(header[k] || '') !== ADH_norm_(h)) bad.push('#' + (k + 1) + ' "' + (header[k] || '') + '" (expected "' + h + '")'); });
  if (header.length !== ADH.CSV_HEADERS.length) bad.push(header.length + ' columns (expected ' + ADH.CSV_HEADERS.length + ')');
  if (bad.length) throw new Error('The NICE report does not have the expected Adherence columns: ' + bad.slice(0, 4).join('; ') +
    '. Check that the report is "Adherence" with details by agent and day. Nothing was changed.');
  return { header: header, rows: out.slice(1) };
}

/** CSV rows → sheet rows A:O (typed). Every date must be inside [from,to]. Pure except date parsing. */
function ADH_rowsFromCsv_(parsed, from, to) {
  var rows = [], days = {};
  parsed.rows.forEach(function (r, i) {
    var line = i + 2;
    if (r.length !== ADH.CSV_HEADERS.length) {
      if (r.every(function (v) { return String(v).trim() === ''; })) return;
      throw new Error('NICE CSV line ' + line + ' has ' + r.length + ' columns (expected 15). Nothing was changed.');
    }
    var ymd = ADH_ymdFromNice_(r[0], line);
    if (ymd < from || ymd > to) throw new Error('NICE CSV line ' + line + ' is dated ' + r[0] + ', outside the requested period ' + from + ' → ' + to + '. Nothing was changed.');
    days[ymd] = 1;
    rows.push({ day: ymd, v: [
      ADH_dateOf_(ymd), ADH_num_(r[1], line, 'Entity ID'), ADH_text_(r[2]), ADH_num_(r[3], line, 'Agent ID'), ADH_text_(r[4]), ADH_text_(r[5]),
      ADH_dur_(r[6], line, 'Scheduled Time'), ADH_dur_(r[7], line, 'Actual Time'), ADH_num_(r[8], line, 'Min. in Adherence'),
      ADH_num_(r[9], line, 'Min. out Adherence'), ADH_pct_(r[10]), ADH_num_(r[11], line, '+/- Min. in Conformance'),
      ADH_pct_(r[12]), ADH_pct_(r[13]), ADH_pct_(r[14])] });
  });
  return rows;
}

function ADH_ymdFromNice_(s, line) {
  var m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/.exec(String(s));
  if (!m) throw new Error('NICE CSV line ' + line + ': unreadable date "' + s + '". Nothing was changed.');
  var y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mo = Number(m[1]), d = Number(m[2]);
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > dim) throw new Error('NICE CSV line ' + line + ': impossible date "' + s + '". Nothing was changed.');
  return y + '-' + ADH_pad_(mo) + '-' + ADH_pad_(d);
}
/** "07:05" (hours can pass 24) → fraction of a day, the way Sheets stores a duration. */
function ADH_dur_(s, line, col) {
  s = String(s).trim();
  if (s === '') return '';
  var m = /^(-?)(\d+):(\d{2})$/.exec(s);
  if (!m) throw new Error('NICE CSV line ' + line + ': unreadable ' + col + ' "' + s + '". Nothing was changed.');
  var mins = Number(m[2]) * 60 + Number(m[3]);
  return (m[1] ? -mins : mins) / 1440;
}
function ADH_num_(s, line, col) {
  s = String(s).replace(/,/g, '').trim();
  if (s === '') return '';
  var n = Number(s);
  if (isNaN(n)) throw new Error('NICE CSV line ' + line + ': "' + col + '" is not a number ("' + s + '"). Nothing was changed.');
  return n;
}
/** "88.94%" → 0.8894; blank or text such as N/A stays as it is (NICE shows N/A when nothing was scheduled). */
function ADH_pct_(s) {
  s = String(s).trim();
  var m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? Math.round(Number(m[1]) * 100) / 10000 : ADH_text_(s);
}
/** Text written to the sheet never becomes a formula (R-7 rule). */
function ADH_text_(s) { s = String(s === null || s === undefined ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; }

/* ============================== WRITE ============================== */
/**
 * Replace the dates [from,to]; every other date stays. Rows are kept in date order (inside a day: NICE's order).
 * Reads and rewrites A:O only; P:W are formulas and are never written.
 */
function ADH_replaceDates_(sh, rows, from, to) {
  var N = ADH.LOAD_COLS, last = ADH_lastRow_(sh), kept = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, N).getValues();
    vals.forEach(function (v) {
      if (v[0] === '' || v[0] === null) return;
      var d = ADH_ymdOf_(v[0]);
      if (!d) return;                                             // a row without a readable date is dropped (it can only be a typing error)
      if (d >= from && d <= to) return;                           // replaced by this load
      kept.push({ day: d, v: v });
    });
  }
  var all = kept.concat(rows);
  all.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });   // stable (V8)
  if (all.length > ADH.MAX_ROWS) throw new Error('Raw Data would have ' + all.length + ' rows (limit ' + ADH.MAX_ROWS + '). Delete an old month first. Nothing was changed.');
  var need = all.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (last >= 2) sh.getRange(2, 1, last - 1, N).clearContent();
  for (var s = 0; s < all.length; s += ADH.WRITE_CHUNK) {
    var part = all.slice(s, s + ADH.WRITE_CHUNK);
    sh.getRange(2 + s, 1, part.length, N).setValues(part.map(function (r) { return r.v; }));
  }
  return { kept: kept.length, total: all.length };
}

/** After a load: lookups resolved? formula columns healthy? minutes consistent? */
function ADH_postCheck_(ss, sh, loaded) {
  var errors = [], notes = [], st = ADH_dbStatus_(ss, true);
  if (!st.ok) errors.push(st.message);
  var last = ADH_lastRow_(sh), unmapped = 0, agents = {}, miss = {}, days = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, ADH.TOTAL_COLS).getValues();
    var top = sh.getRange('P1:W1').getDisplayValues()[0];
    top.forEach(function (v, j) { if (/^#(REF|N\/A|ERROR|VALUE|NAME)/.test(String(v))) errors.push('Formula column ' + ADH_col_(16 + j) + ' shows ' + v + ' (run repairAdherenceFormulas).'); });
    var badMin = 0;
    vals.forEach(function (v) {
      var d = ADH_ymdOf_(v[0]); if (d) days[d] = 1;
      agents[v[3]] = 1;
      if (v[15] === ADH.MISSING) { unmapped++; miss[v[3]] = v[4]; }
      if (typeof v[20] === 'number' && typeof v[8] === 'number' && typeof v[9] === 'number' && v[20] !== v[8] + v[9]) badMin++;
    });
    if (badMin) notes.push(badMin + ' rows where Scheduled Time Min ≠ Min. in + Min. out Adherence (as NICE reported them).');
  }
  if (unmapped) notes.push(unmapped + ' rows (' + Object.keys(miss).length + ' agents) are not in the Database: they are kept but left out of the VRI/Operator views until the Database has them.');
  return { errors: errors, notes: notes, unmapped: unmapped, days: Object.keys(days).length, agents: Object.keys(agents).length,
           unmappedAgents: Object.keys(miss).map(function (k) { return { id: k, name: miss[k] }; }) };
}

/** Recomputes P:W in script from the Database and compares with what the formulas show (adhCheckSetup). Pure. */
function ADH_verifyLookups_(vals, dbt) {
  var out = { checked: 0, mismatch: 0, examples: [] };
  vals.forEach(function (v) {
    if (v[3] === '' || v[3] === null) return;
    var r = dbt.byId[String(v[3]).trim()], exp;
    if (!r) exp = [ADH.MISSING, ADH.MISSING, ADH.MISSING, ADH.MISSING, ADH.MISSING, ADH.MISSING, ADH.MISSING];
    else exp = [r.name, r.seatLang, r.lg, r.sup, r.lg === 'PENs' ? 'Operator' : 'VRI', r.platform, r.manager];
    var got = [v[15], v[16], v[17], v[18], v[19], v[21], v[22]].map(function (x) { return String(x); });
    out.checked++;
    for (var k = 0; k < exp.length; k++) if (String(exp[k]) !== got[k]) {
      out.mismatch++; if (out.examples.length < 3) out.examples.push('agent ' + v[3] + ' ' + ADH.FORMULA_HEADERS[k < 5 ? k : k + 1] + ': "' + got[k] + '" vs "' + exp[k] + '"'); break;
    }
    if (typeof v[6] === 'number' && v[20] !== Math.round(v[6] * 1440)) { out.mismatch++; if (out.examples.length < 3) out.examples.push('agent ' + v[3] + ' Scheduled Time Min'); }
  });
  return out;
}

/** Database tab as { byId } using the header names (first match wins, as VLOOKUP). */
function ADH_dbTable_(ss) {
  var db = ss.getSheetByName(ADH.DB), last = db.getLastRow(), w = Math.min(40, db.getMaxColumns());
  var vals = last >= 1 ? db.getRange(1, 1, last, w).getValues() : [[]], head = vals[0].map(ADH_norm_), ix = {};
  Object.keys(ADH.DB_COLS).forEach(function (k) { ix[k] = head.indexOf(ADH_norm_(ADH.DB_COLS[k])); });
  var byId = {};
  for (var i = 1; i < vals.length; i++) {
    var id = String(vals[i][ix.id] === undefined ? '' : vals[i][ix.id]).trim();
    if (!id || byId[id]) continue;
    var r = {}; Object.keys(ix).forEach(function (k) { r[k] = ix[k] >= 0 ? vals[i][ix[k]] : ''; });
    byId[id] = r;
  }
  return { byId: byId };
}

/* ============================== _Control / _Load Log ============================== */
function ADH_controlLayout_(c) {
  c.getRange('A1:B1').setValues([['Status', 'Value']]).setFontWeight('bold');
  c.getRange('A2:A8').setValues([['Last load'], ['Last load period'], ['Last load status'], ['Rows in Raw Data'], ['Days loaded'],
    ['Rows not found in Database'], ['Last load by']]);
  c.getRange('A9').setValue('Lookup checksum (changes when the Database changes a lookup)');
  c.getRange('B9').setFormula("=SUMPRODUCT(LEN('" + ADH.SHEET + "'!P2:W))");
  c.getRange('A10').setValue('Settings (edit B11:B13; the next run or repairAdherenceFormulas applies them)').setFontWeight('bold');
  c.getRange('A11:A13').setValues([['Database source spreadsheet'], ['Database source tab (change each month, e.g. Database Nov\'26)'], ['Database range']]);
  c.getRange('D1').setValue('Rows per date').setFontWeight('bold');
  c.getRange('D2').setFormula("=IFERROR(QUERY({'" + ADH.SHEET + "'!A2:A,'" + ADH.SHEET + "'!T2:T},\"select Col1, count(Col1) where Col1 is not null group by Col1 pivot Col2 label Col1 'Date'\",0),\"No data yet\")");
  c.getRange('D3:D').setNumberFormat('m/d/yyyy');
  c.getRange('I1').setValue('Agents not in Database').setFontWeight('bold');
  c.getRange('I2').setFormula("=IFERROR(UNIQUE(FILTER({'" + ADH.SHEET + "'!D2:D,'" + ADH.SHEET + "'!E2:E},'" + ADH.SHEET + "'!P2:P=\"" + ADH.MISSING + "\")),\"None\")");
  c.setColumnWidth(1, 330);
}
function ADH_control_(ss, map) {
  var c = ss.getSheetByName(ADH.CONTROL);
  if (!c) return;
  Object.keys(map).forEach(function (a1) { c.getRange(a1).setValue(map[a1]); });
}
function ADH_log_(ss, row) { var l = ss.getSheetByName(ADH.LOG); if (l) l.appendRow(row.map(function (v) { return typeof v === 'string' ? ADH_text_(v) : v; })); }

/* ============================== ACCESS / HELPERS ============================== */
/** Run roles: registered + role in ADH.RUN_ROLES (server-side; the page only hides the button). Returns the e-mail. */
function ADH_requireRun_() {
  requireRegistered_();
  var role = typeof dashRole_ === 'function' ? dashRole_() : '';
  var ok = ADH.RUN_ROLES.some(function (r) { return r.toLowerCase() === String(role || '').toLowerCase(); });
  if (!ok) throw new Error('Start Automation is available to ' + ADH.RUN_ROLES.join(', ') + ' only.');
  try { return currentUserEmail_() || 'unknown'; } catch (e) { return 'unknown'; }
}
function ADH_canRun_(role) { return ADH.RUN_ROLES.some(function (r) { return r.toLowerCase() === String(role || '').toLowerCase(); }); }

function ADH_takePlan_(runId) {
  var c = CacheService.getScriptCache(), raw = c.get('ADH_RUN_' + String(runId || ''));
  if (!raw) throw new Error('This run expired or is unknown (runs are valid for 30 minutes). Press Start Automation again.');
  var plan = JSON.parse(raw);
  c.remove('ADH_RUN_' + runId);                               // one save per run
  return plan;
}

function ADH_say_(msg) { Logger.log(msg); return msg; }
function ADH_ss_() {
  var id = PropertiesService.getScriptProperties().getProperty(ADH.PROP_ID);
  if (!id) throw new Error('The Adherence spreadsheet is not set up yet (Script Property ' + ADH.PROP_ID + ' is missing). Ask the app owner.');
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw new Error('You do not have access to the Adherence Data spreadsheet. Ask the owner to share it with you (Editor to run the automation, Viewer to see the dashboard).'); }
}
function ADH_sheet_(ss) {
  var sh = (ss || ADH_ss_()).getSheetByName(ADH.SHEET);
  if (!sh) throw new Error('Sheet "' + ADH.SHEET + '" not found. Run setupAdherenceSheet() first.');
  return sh;
}
function ADH_lastRow_(sh) {
  var max = sh.getMaxRows();
  if (max < 2) return 1;
  var col = sh.getRange(2, 1, max - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) if (col[i][0] !== '' && col[i][0] !== null) return i + 2;
  return 1;
}
function ADH_today_() { return Utilities.formatDate(new Date(), ADH.TZ, 'yyyy-MM-dd'); }
function ADH_dateOf_(ymd) { return Utilities.parseDate(ymd, ADH.TZ, 'yyyy-MM-dd'); }
function ADH_ymdOf_(d) {
  if (d instanceof Date && !isNaN(d.getTime())) return Utilities.formatDate(d, ADH.TZ, 'yyyy-MM-dd');
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return '';
}
function ADH_pad_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function ADH_addDays_(ymd, n) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
function ADH_days_(a, b) { var p = a.split('-').map(Number), q = b.split('-').map(Number); return Math.round((Date.UTC(q[0], q[1] - 1, q[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 864e5) + 1; }
function ADH_niceDate_(ymd) { var p = ymd.split('-').map(Number); return p[1] + '/' + p[2] + '/' + String(p[0]).slice(2); }    // NICE: M/D/YY
function ADH_monthName_(m) { return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]; }
function ADH_label_(a, b) {
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], p = a.split('-').map(Number), q = b.split('-').map(Number);
  return a === b ? p[2] + ' ' + M[p[1] - 1] + ' ' + p[0] : p[2] + ' ' + M[p[1] - 1] + ' – ' + q[2] + ' ' + M[q[1] - 1] + ' ' + q[0];
}
function ADH_norm_(h) { return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9%\/+\-]/g, ''); }
function ADH_col_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
