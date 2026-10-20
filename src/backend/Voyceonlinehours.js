/**
 * VoyceOnlineHours.gs — NEW FILE (does not change any existing file)
 * -----------------------------------------------------------------------------
 * Feeds the "Voyce Online Hours" sheet in a SEPARATE spreadsheet (compact 26-column layout,
 * owner decision 2026-10-01) from the Reporting automation:
 *
 *   A:H   online rows  <- report 12 (Provider Online Time Detail). The "Language Pairs" column
 *         is removed by name; of the remaining 17 columns only Provider Id, Provider Name,
 *         Start Time, OffReason, Minutes, Seconds, ServiceMinutes, ServiceSeconds are kept.
 *         Dropped as redundant: Id (not unique), Company and OnOff (constant), End Time,
 *         ServiceRelated, Occupancy minutes/seconds and the two per-row % columns.
 *   A:C + I:K  call rows <- cleaned two-report output (Voyce 37 + Sisense Short Calls):
 *         Interpreter Id, Interpreter Name, RequestTime -> A, B, C;
 *         Accepted Codes, Transaction Id, Short Calls -> I, J, K   (stacked under the online rows)
 *   L:Z   ONE array formula per column in row 1 (header + data). Nothing is filled down, so
 *         nothing can go stale; the loader rewrites row 1 on every run (self-repair) and never
 *         writes into L:Z.
 *
 * Reference sheet "SD Dis" (=IMPORTRANGE of the Roster Database month tab) is read only (never written).
 *
 * Loading policy (owner decision 2026-10-01):
 *   - once: vohLoadCurrentMonth() loads the 1st of this month → today (7-day chunks; if it needs
 *     more than ~5 minutes it stops and you run vohContinueInitialLoad() again to resume)
 *   - every hour: vohScheduledHourly() re-loads yesterday + today so far. Create the trigger
 *     by hand (Apps Script → Triggers → Add Trigger → vohScheduledHourly → Time-driven → Hour timer →
 *     Every hour). This file does NOT use ScriptApp, so the app's OAuth scopes (appsscript.json)
 *     stay unchanged and no web-app user has to re-authorise.
 *   - months are never archived or cleared; old data stays until someone deletes rows by hand
 *   - rows are kept in date order (per day: online rows, then call rows), so a daily run only
 *     rewrites the end of the sheet and deleting an old month is one contiguous block of rows
 *
 * Public entry points (all guarded):
 *   setupVoyceOnlineHoursSheet()          editor, once        requireSetupAccess_
 *   vohLoadCurrentMonth()                 editor, once        requireSetupAccess_
 *   vohContinueInitialLoad()              editor (resume)     requireSetupAccess_
 *   loadVoyceOnlineHours(from, to)        app button          requireElevated_
 *   vohScheduledHourly()                  time trigger        requireSetupAccess_
 *   repairVoyceOnlineHoursFormulas()      editor/any time     requireSetupAccess_
 *   TEST_vohProbe(day)                    editor, no writes   requireSetupAccess_
 *
 * Depends on (existing, live HEAD): runAutomatedVoyceReports(from, to),
 * requireElevated_(), requireSetupAccess_(). Dates are 'yyyy-MM-dd' strings.
 * Script Property: VOH_SPREADSHEET_ID (id of the new spreadsheet).
 */

var VOH = {
  TZ: 'America/New_York',
  PROP_ID: 'VOH_SPREADSHEET_ID',
  SHEET: 'Voyce Online Hours',
  CONTROL: '_Control',
  LOG: '_Load Log',
  ROSTER: 'SD Dis',
  MAX_DAYS: 31,
  WRITE_CHUNK: 20000,
  RUN_FLAG: 'VOH_RUNNING',
  DAILY_BACK_DAYS: 1,              // the hourly run re-loads yesterday and today (owner, 2026-10-02)
  CHUNK_DAYS: 7,                   // initial load: days per fetch
  RUN_BUDGET_MS: 300000,           // initial load: start another chunk only if it should end before ~5 min
  CELL_WARN: 8000000,              // Google limit is 10,000,000 cells per spreadsheet
  CELL_STOP: 9500000,
  P_INIT_NEXT: 'VOH_INIT_NEXT',
  P_INIT_END: 'VOH_INIT_END',

  // Report 12 after removing the Language Pairs column: the 17 headers we expect to receive.
  SRC_HEADERS: ['Id', 'Company', 'Provider Id', 'Provider Name',
    'Start Time (Eastern Standard Time)', 'End Time (Eastern Standard Time)',
    'ServiceRelated', 'OnOff', 'OffReason', 'Minutes', 'Seconds', 'ServiceMinutes',
    'ServiceSeconds', 'OccupancyMinutes', 'OccupancySeconds', 'Service/Online %',
    'Occupancy/Online %'],
  // Which of those 17 are kept, in sheet order A..H (indexes into SRC_HEADERS)
  SRC_KEEP: [2, 3, 4, 8, 9, 10, 11, 12],
  SRC_NUMERIC: [2, 9, 10, 11, 12],              // Provider Id, Minutes, Seconds, ServiceMinutes, ServiceSeconds

  // Cleaned output (Reporting VOYCE_OUTPUT_COLUMNS order, D-31)
  CALL_HEADERS: ['Interpreter Id', 'Interpreter Name', 'RequestTime (Eastern Standard Time)',
    'Accepted Codes', 'Transaction Id', 'Short Calls'],

  // Row 1 of the loaded columns A:K
  LOAD_HEADERS: ['Provider Id', 'Provider Name', 'Start / Request Time (ET)', 'OffReason', 'Minutes',
    'Seconds', 'ServiceMinutes', 'ServiceSeconds', 'Accepted Codes', 'Transaction Id', 'Short Calls'],
  LOAD_COLS: 11,                                // A:K
  TOTAL_COLS: 27,                               // A:AA
  FIRST_FORMULA_COL: 12,                        // L
  LAST_FORMULA_COL: 26,                         // Z
  // AA "Ign": typed by hand. Blank = count the row, 1 = leave the row out of the dashboard (owner, 2026-10-04).
  IGN_COL: 27,
  IGN_HEADER: 'Ign'
};

/* ============================== FORMULAS (L:Z) ============================== */
/** One formula per column, placed in row 1. Key = column A (Provider Id, present on every data row). */
function VOH_formulas_() {
  // "SD Dis" holds =IMPORTRANGE(Roster Database, 'Database Oct''26'!A1:AG) since 2026-10-10:
  // M = Voyce ID, C = Interpreter name, Q = Manager (ACM), AF = Seat Language, G = Language Group, R = Supervisor (TL), L = ID (FG ID).
  var look = function (header, rosterCol) {
    return '=ARRAYFORMULA({"' + header + '";IF(A2:A="",,IFNA(VLOOKUP(A2:A&"",' +
      "{'SD Dis'!$M$2:$M&\"\",'SD Dis'!$" + rosterCol + '$2:$' + rosterCol +
      '},2,FALSE),"Not in roster"))})';
  };
  return {
    L: look('ACM', 'Q'),
    M: look('Agent Name', 'C'),
    N: look('Language', 'AF'),                    // Seat Language, as the workbook
    O: look('Language Group', 'G'),
    P: look('Team leader', 'R'),
    Q: look('FG ID', 'L'),
    R: '=ARRAYFORMULA({"Paid Hours";IF(A2:A="",,IF(E2:E="",0,E2:E/60))})',
    S: '=ARRAYFORMULA({"Talk Time";IF(A2:A="",,IF(G2:G="",0,G2:G/60))})',
    T: '=ARRAYFORMULA({"Date";IF(C2:C="",,INT(C2:C))})',
    U: '=ARRAYFORMULA({"Month";IF(C2:C="",,TEXT(C2:C,"yyyy-mm"))})',   // Week is day-of-month: use with Month
    V: '=ARRAYFORMULA({"Week";IF(C2:C="",,IF(DAY(C2:C)>21,"week4",IF(DAY(C2:C)>14,"week3",IF(DAY(C2:C)>7,"week2","week1"))))})',
    W: '=ARRAYFORMULA({"Assigned Calls";IF(A2:A="",,IF(J2:J<>"",1,0))})',
    X: '=ARRAYFORMULA({"Accepted Calls";IF(A2:A="",,IF(I2:I<>"",1,0))})',
    Y: '=ARRAYFORMULA({"Other:";IF(A2:A="",,IF(TRIM(D2:D)="Other:",1,0))})',
    Z: '=ARRAYFORMULA({"Total Offline Codes Usage";IF(A2:A="",,IF(D2:D<>"",1,0))})'
  };
}

/* ============================== SETUP / REPAIR ============================== */
function setupVoyceOnlineHoursSheet() {
  requireSetupAccess_();
  var ss = VOH_ss_();
  [VOH.ROSTER].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('Reference sheet "' + n + '" is missing. Add it with the IMPORTRANGE of the Roster Database month tab first.');
  });
  if (ss.getSpreadsheetTimeZone() !== VOH.TZ) {
    throw new Error('Set File > Settings > Time zone to (GMT-04:00/-05:00) Eastern Time - New York first. Current: ' + ss.getSpreadsheetTimeZone());
  }
  var sh = ss.getSheetByName(VOH.SHEET) || ss.insertSheet(VOH.SHEET, 0);
  var note = '';
  if (String(sh.getRange('A1').getValue()) === 'Id') {                // the earlier 38-column layout (first header "Id")
    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
    sh.clear();
    note = ' The earlier 38-column layout was cleared; run vohLoadCurrentMonth() to load the data again.';
  }
  var T = VOH.TOTAL_COLS;
  if (sh.getMaxColumns() < T) sh.insertColumnsAfter(sh.getMaxColumns(), T - sh.getMaxColumns());
  if (sh.getMaxColumns() > T) sh.deleteColumns(T + 1, sh.getMaxColumns() - T);   // fewer cells per row
  sh.getRange(1, 1, 1, VOH.LOAD_COLS).setValues([VOH.LOAD_HEADERS]);
  VOH_writeFormulas_(sh);
  sh.setFrozenRows(1);
  sh.getRange('C2:C').setNumberFormat('m/d/yyyy h:mm:ss');
  sh.getRange('T2:T').setNumberFormat('m/d/yyyy');
  sh.getRange('R2:S').setNumberFormat('0.00');
  sh.getRange('A2:A').setNumberFormat('0');
  sh.getRange('I2:J').setNumberFormat('0');
  sh.getRange(1, 1, 1, T).setFontWeight('bold');
  sh.getRange('L1:Z1').setBackground('#e8f0fe');                  // formula columns
  VOH_ensureIgn_(sh, true);                                        // AA "Ign" (typed by hand)
  // Warning-only protection: anyone typing into a formula column is warned (spill would break).
  var desc = 'VOH formula columns — do not type here';
  var exists = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) { return p.getDescription() === desc; });
  if (!exists) sh.getRange('L:Z').protect().setDescription(desc).setWarningOnly(true);
  VOH_controlSheet_(ss);
  VOH_logSheet_(ss);
  return VOH_say_('Voyce Online Hours sheet is ready in ' + ss.getName() + '.' + note);
}

function repairVoyceOnlineHoursFormulas() {
  requireSetupAccess_();
  var sh = VOH_sheet_();
  return VOH_say_(VOH_writeFormulas_(sh));
}

/**
 * Self-repair: rewrites any row-1 formula that differs from the definition, then looks for #REF!
 * in row 1. In Sheets that error means something was typed or pasted inside the spill area, so the
 * cells below row 1 in that column are cleared (they only ever hold spilled results).
 */
function VOH_writeFormulas_(sh) {
  var f = VOH_formulas_(), fixed = [], maxR = sh.getMaxRows();
  Object.keys(f).forEach(function (col) {
    var cell = sh.getRange(col + '1');
    if (cell.getFormula() !== f[col]) { cell.setFormula(f[col]); fixed.push(col + '1 rewritten'); }
  });
  SpreadsheetApp.flush();
  Object.keys(f).forEach(function (col) {
    if (String(sh.getRange(col + '1').getDisplayValue()).indexOf('#REF') === 0 && maxR > 1) {
      sh.getRange(col + '2:' + col + maxR).clearContent();
      fixed.push(col + ' spill area cleared');
    }
  });
  if (fixed.length) SpreadsheetApp.flush();
  return fixed.length ? ('Repaired: ' + fixed.join(', ')) : 'Formulas OK.';
}

/** Run once from the editor to add the "Ign" column (AA) to a sheet that already exists. Safe to run again. */
function setupVoyceIgnColumn() {
  requireSetupAccess_();
  var sh = VOH_sheet_();
  VOH_ensureIgn_(sh, true);
  VOH_ignControl_(VOH_ss_().getSheetByName(VOH.CONTROL) || VOH_controlSheet_(VOH_ss_()), true);
  return VOH_say_('Column AA "Ign" is ready: leave a cell blank to count the row, type 1 to leave it out of the dashboard.');
}

/**
 * AA "Ign" is the only column typed by hand. Makes sure the sheet has the column and its header; with
 * full=true also the drop-down (blank or 1), number format and note. Cheap enough to run on every load.
 */
function VOH_ensureIgn_(sh, full) {
  if (sh.getMaxColumns() < VOH.IGN_COL) sh.insertColumnsAfter(sh.getMaxColumns(), VOH.IGN_COL - sh.getMaxColumns());
  var h = sh.getRange(1, VOH.IGN_COL);
  var fresh = String(h.getValue()) !== VOH.IGN_HEADER;
  if (fresh) h.setValue(VOH.IGN_HEADER);
  if (full || fresh) {
    h.setFontWeight('bold').setBackground('#fff4ce');
    try { h.setNote('Typed by hand. Leave blank to count the row; type 1 to leave the row out of the dashboard (test calls, trials, anything management asks to exclude).'); } catch (ignore) {}
    var col = sh.getRange(2, VOH.IGN_COL, Math.max(1, sh.getMaxRows() - 1), 1);
    col.setNumberFormat('0');
    try {
      col.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['1'], true).setAllowInvalid(false)
        .setHelpText('Leave blank, or choose 1 to leave this row out of the dashboard.').build());
    } catch (ignore) {}
  }
}

/** _Control A8:B9: how many rows are ignored, and a checksum that changes whenever a flag is added, removed or moved. */
function VOH_ignControl_(c, force) {
  var col = VOH_colName_(VOH.IGN_COL), rng = "'" + VOH.SHEET + "'!" + col + '2:' + col;
  if (force || String(c.getRange('A8').getValue()) !== 'Ignored rows (Ign = 1)') {
    c.getRange('A8:A9').setValues([['Ignored rows (Ign = 1)'], ['Ign checksum (row numbers of ignored rows)']]);
    c.getRange('B8').setFormula('=COUNTIF(' + rng + ',1)');
    c.getRange('B9').setFormula('=SUMPRODUCT((' + rng + '=1)*ROW(' + rng + '))');
  }
}

/** True for a hand-typed 1 (number or text); anything else, including blank and 0, keeps the row. */
function VOH_isIgn_(v) { return v === 1 || (typeof v === 'string' && v.trim() === '1'); }

/** Identity of a loaded row, so a hand-typed Ign flag follows its row when the hourly load rewrites it. */
function VOH_rowKey_(v) {
  var t = v[2] instanceof Date ? Math.round(v[2].getTime() / 1000) : String(v[2]);
  return (v[9] !== '' && v[9] !== null && v[9] !== undefined)
    ? 'c|' + v[0] + '|' + v[9] + '|' + t
    : 'o|' + v[0] + '|' + t + '|' + String(v[3]);
}

function VOH_controlSheet_(ss) {
  var c = ss.getSheetByName(VOH.CONTROL) || ss.insertSheet(VOH.CONTROL);
  c.getRange('A1:A7').setValues([['Status'], ['Last load'], ['Last load range'], ['Last load status'],
    ['Data rows in sheet'], ['Spreadsheet cells used (limit 10,000,000)'], ['Initial load']]);
  c.getRange('B1').setValue('Value');
  c.getRange('A1:B1').setFontWeight('bold');
  c.getRange('D1').setValue('Rows per date and type (checks for missing days)').setFontWeight('bold');
  c.getRange('D2').setFormula("=IFERROR(QUERY({'" + VOH.SHEET + "'!T2:T,ARRAYFORMULA(IF('" + VOH.SHEET +
    "'!J2:J<>\"\",\"Call\",\"Online\"))},\"select Col1, count(Col1) where Col1 is not null group by Col1 pivot Col2 label Col1 'Date'\",0),\"No data yet\")");
  c.getRange('D2:D').setNumberFormat('m/d/yyyy');
  VOH_ignControl_(c, true);
  c.getRange('H1').setValue('Providers not in SD Dis').setFontWeight('bold');
  c.getRange('H2').setFormula("=IFERROR(UNIQUE(FILTER({'" + VOH.SHEET + "'!A2:A,'" + VOH.SHEET +
    "'!B2:B},'" + VOH.SHEET + "'!M2:M=\"Not in roster\")),\"None\")");
}

function VOH_logSheet_(ss) {
  var l = ss.getSheetByName(VOH.LOG) || ss.insertSheet(VOH.LOG);
  if (!l.getRange('A1').getValue()) {
    l.getRange(1, 1, 1, 11).setValues([['Run at', 'By', 'From', 'To', 'Mode', 'Online rows loaded',
      'Call rows loaded', 'Rows kept from other dates', 'Seconds', 'Status', 'Message']]).setFontWeight('bold');
    l.setFrozenRows(1);
  }
}

/* ============================== LOADING ============================== */
/** App button / editor: fetch [from,to] and replace those dates in the sheet. */
function loadVoyceOnlineHours(from, to) {
  requireElevated_();
  var r = VOH_load_(from, to, 'manual');
  VOH_say_('Loaded ' + from + ' → ' + to + ': ' + r.online + ' online rows, ' + r.calls + ' call rows, ' + r.seconds + ' s. ' + r.message);
  return r;
}

/**
 * Time trigger (every hour): re-load yesterday + today so far.
 * Replace-by-date makes this safe to repeat. If another load is running (initial load,
 * a manual load) this hour's run is skipped quietly instead of failing.
 */
function vohScheduledHourly() {
  requireSetupAccess_();
  var today = VOH_today_();
  if (CacheService.getScriptCache().get(VOH.RUN_FLAG)) return VOH_say_('Skipped: another load is running.');
  if (PropertiesService.getScriptProperties().getProperty(VOH.P_INIT_NEXT)) return VOH_say_('Skipped: the initial load is still in progress.');
  return VOH_say_('Hourly load: ' + VOH_load_(VOH_addDays_(today, -VOH.DAILY_BACK_DAYS), today, 'scheduled').message);
}
/** Kept so an older trigger or button that still calls the old name keeps working. */
function vohScheduledDaily() { return vohScheduledHourly(); }

/** One-time initial load: 1st of the current month → today (today is partial; the hourly run keeps refreshing it). */
function vohLoadCurrentMonth() {
  requireSetupAccess_();
  var today = VOH_today_(), first = today.slice(0, 8) + '01', end = today;
  var p = PropertiesService.getScriptProperties();
  p.setProperty(VOH.P_INIT_NEXT, first);
  p.setProperty(VOH.P_INIT_END, end);
  return VOH_say_(VOH_continueInit_());
}

/** Resumes the initial load from where it stopped (run it again until it says "complete"). */
function vohContinueInitialLoad() {
  requireSetupAccess_();
  return VOH_say_(VOH_continueInit_());
}

function VOH_continueInit_() {
  var p = PropertiesService.getScriptProperties(), t0 = Date.now(), done = [], longest = 0;
  var next = p.getProperty(VOH.P_INIT_NEXT), end = p.getProperty(VOH.P_INIT_END);
  if (!next || !end) return 'No initial load in progress.';
  while (next <= end) {
    var to = VOH_addDays_(next, VOH.CHUNK_DAYS - 1);
    if (to > end) to = end;
    var c0 = Date.now();
    VOH_load_(next, to, 'initial');
    longest = Math.max(longest, Date.now() - c0);
    done.push(next + '→' + to);
    next = VOH_addDays_(to, 1);
    p.setProperty(VOH.P_INIT_NEXT, next);
    if (next <= end && (Date.now() - t0) + longest * 1.2 > VOH.RUN_BUDGET_MS) {
      VOH_setControl_('B7', 'Loaded up to ' + VOH_addDays_(next, -1) + '; run vohContinueInitialLoad to resume from ' + next);
      return 'Loaded ' + done.join(', ') + '. Not finished: run vohContinueInitialLoad again to resume from ' + next + '.';
    }
  }
  p.deleteProperty(VOH.P_INIT_NEXT);
  p.deleteProperty(VOH.P_INIT_END);
  VOH_setControl_('B7', 'Complete (' + new Date() + ')');
  return 'Initial load complete: ' + done.join(', ');
}

function VOH_load_(from, to, mode) {
  var t0 = Date.now(), who = VOH_who_();
  VOH_checkRange_(from, to);
  var cache = CacheService.getScriptCache();
  if (cache.get(VOH.RUN_FLAG)) throw new Error('A Voyce Online Hours load is already running. Try again in a few minutes.');
  cache.put(VOH.RUN_FLAG, who, 600);
  try {
    var res = runAutomatedVoyceReports(from, to);                    // existing fetch + cleaning
    var built = VOH_buildRows_(res.onlineTime, res.performance);
    var sh = VOH_sheet_();
    var stats = VOH_upsert_(sh, built, from, to);
    try { var ctl = VOH_ss_().getSheetByName(VOH.CONTROL); if (ctl) VOH_ignControl_(ctl, false); } catch (ignore) {}   // _Control B8:B9 (Ign count + checksum)
    VOH_writeFormulas_(sh);                                          // self-repair every run
    SpreadsheetApp.flush();
    var check = VOH_postCheck_(sh);
    var cells = VOH_cells_(sh.getParent ? sh.getParent() : VOH_ss_());
    if (cells > VOH.CELL_WARN) check += '; WARNING spreadsheet uses ' + cells + ' of 10,000,000 cells — delete old months soon';
    if (stats.reordered) check += '; rows were not in date order (sheet was sorted by hand) and were re-ordered';
    if (stats.ignDropped) check += '; NOTE: ' + stats.ignDropped + ' Ign flag(s) dropped because Voyce no longer returns that row';
    var secs = Math.round((Date.now() - t0) / 1000);
    VOH_log_([new Date(), who, from, to, mode, built.online.length, built.calls.length,
      stats.untouched + stats.keptAfter, secs, /ERROR/.test(check) ? 'CHECK' : 'OK', check]);
    VOH_setControl_('B2', new Date());
    VOH_setControl_('B3', from + ' → ' + to);
    VOH_setControl_('B4', check);
    VOH_setControl_('B5', stats.total);
    VOH_setControl_('B6', cells);
    // Prepare the dashboard's data straight away (Dash_Voyce.gs), so the first person to open it after
    // this load does not wait. Optional: skipped when Dash_Voyce.gs is not installed; never fails the load.
    try { if (typeof VOHD_warm_ === 'function') VOHD_warm_(); } catch (ignore) {}
    return { ok: true, from: from, to: to, online: built.online.length, calls: built.calls.length,
      totalRows: stats.total, rewritten: stats.written, seconds: secs, message: check };
  } catch (e) {
    try { VOH_log_([new Date(), who, from, to, mode, '', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    cache.remove(VOH.RUN_FLAG);
  }
}

/**
 * Converts the two automation results into sheet rows (11 loaded columns A:K). Pure (no Sheets calls) → testable.
 * Each row: { day: 'yyyy-MM-dd', v: [A..K], call: bool }.
 */
function VOH_buildRows_(onlineTime, performance) {
  var ot = VOH_table_(onlineTime, 'Provider Online Time (report 12)');
  var pf = VOH_table_(performance, 'cleaned two-report output');

  // Step 1: drop the "Language Pairs" column (found by name; in the real report it is the 5th column),
  // validate the remaining 17 headers, keep the 8 columns that are used.
  if (ot.header.length !== 18) {
    throw new Error('Report 12 has ' + ot.header.length + ' columns; expected 18 (17 + Language Pairs). Headers: ' + ot.header.join(' | '));
  }
  var lpIdx = -1;
  ot.header.forEach(function (h, i) { if (lpIdx < 0 && /^\s*language\s*pairs?\s*$/i.test(String(h))) lpIdx = i; });
  if (lpIdx < 0) throw new Error('Report 12 has no "Language Pairs" column. Headers: ' + ot.header.join(' | '));
  var dropLp = function (arr) { return arr.slice(0, lpIdx).concat(arr.slice(lpIdx + 1)); };
  VOH_expectHeaders_(dropLp(ot.header), VOH.SRC_HEADERS, 'Report 12 (after removing "' + ot.header[lpIdx] + '")');
  var online = [];
  ot.rows.forEach(function (r, i) {
    if (!r || r.every(function (v) { return v === '' || v === null || v === undefined; })) return;
    var src = dropLp(r), out = [];
    VOH.SRC_KEEP.forEach(function (si, k) {
      var x = src[si];
      if (si === 4) x = VOH_toDate_(x, 'report 12 row ' + (i + 2) + ' Start Time');
      else if (VOH.SRC_NUMERIC.indexOf(si) >= 0) x = VOH_toNum_(x);
      else x = (x === null || x === undefined) ? '' : String(x);
      out.push(x);
    });
    if (out[0] === '') return;                                       // no Provider Id → not a data row
    out.push('', '', '');                                            // I:K belong to call rows
    online.push({ day: VOH_day_(out[2]), v: out, call: false });
  });

  // Step 2: cleaned output: first 3 columns → A, B, C; last 3 → I, J, K.
  VOH_expectHeaders_(pf.header, VOH.CALL_HEADERS, 'Cleaned output');
  var calls = [];
  pf.rows.forEach(function (r, i) {
    if (!r || String(r[4] === undefined ? '' : r[4]).trim() === '') return;     // no Transaction Id
    var when = VOH_toDate_(r[2], 'cleaned row ' + (i + 2) + ' RequestTime');
    var acc = String(r[3] === undefined || r[3] === null ? '' : r[3]).trim();
    var short = VOH_toNum_(r[5]);
    calls.push({ day: VOH_day_(when), call: true, v: [VOH_toNum_(r[0]), String(r[1] || ''), when, '', '', '', '', '',
      acc === '' ? '' : VOH_toNum_(acc), VOH_toNum_(r[4]), short === '' ? 0 : short] });
  });
  return { online: online, calls: calls };
}

/** Date order; inside one day online rows come before call rows. */
function VOH_rowOrder_(a, b) {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return (a.call ? 1 : 0) - (b.call ? 1 : 0);
}

/**
 * Replace the dates [from,to]; every other date stays. Rows are in date order, so only the part of the
 * sheet from the first row dated >= from is read and rewritten (for the hourly run: yesterday and today).
 * Rows above that point are never touched. A:K is written, plus AA "Ign" (typed by hand): a flag on a rewritten
 * row is found again by the row's identity (VOH_rowKey_) and written next to the new row; flags on rows that are only
 * kept travel with those rows. Formula columns L:Z are never written.
 */
function VOH_upsert_(sh, built, from, to) {
  var N = VOH.LOAD_COLS, IC = VOH.IGN_COL;
  VOH_ensureIgn_(sh, false);                                          // the sheet needs column AA before anything is written
  var last = VOH_lastDataRow_(sh), cut = last + 1, reordered = false;
  if (last >= 2) {
    var days = sh.getRange(2, 3, last - 1, 1).getValues().map(function (r) { return VOH_day_(r[0]); });
    for (var i = 1; i < days.length; i++) if (days[i] < days[i - 1]) { reordered = true; break; }
    if (reordered) cut = 2;                                           // sorted by hand: rebuild the order once
    else { for (var k = 0; k < days.length; k++) if (days[k] >= from) { cut = k + 2; break; } }
  }
  var keptAfter = [], flagged = {}, flaggedN = 0;
  if (cut <= last) {
    var n = last - cut + 1;
    var vals = sh.getRange(cut, 1, n, N).getValues();
    var igv = sh.getRange(cut, IC, n, 1).getValues();                 // AA "Ign", typed by hand
    for (var j = 0; j < n; j++) {
      if (vals[j][0] === '' || vals[j][0] === null) continue;
      var d = VOH_day_(vals[j][2]);
      if (d >= from && d <= to) {                                      // replaced by this load: its Ign flag must follow the row
        if (VOH_isIgn_(igv[j][0])) { var fk = VOH_rowKey_(vals[j]); flagged[fk] = (flagged[fk] || 0) + 1; flaggedN++; }
        continue;
      }
      keptAfter.push({ day: d, v: vals[j], call: vals[j][9] !== '' && vals[j][9] !== null, ign: igv[j][0] });
    }
  }
  var carried = 0;
  built.online.concat(built.calls).forEach(function (r) {            // a rewritten row keeps its flag (found by its identity, not its position)
    var rk = flaggedN ? VOH_rowKey_(r.v) : '';
    if (rk && flagged[rk] > 0) { flagged[rk]--; r.ign = 1; carried++; }   // identical rows share a key: each flag is given out once
    else r.ign = '';
  });
  var tail = keptAfter.concat(built.online, built.calls).sort(VOH_rowOrder_);   // stable sort (V8)
  var endRow = cut + tail.length - 1;

  // Capacity guard before anything is changed.
  var ss = sh.getParent ? sh.getParent() : VOH_ss_();
  var extraRows = Math.max(0, endRow - sh.getMaxRows());
  if (VOH_cells_(ss) + extraRows * sh.getMaxColumns() > VOH.CELL_STOP) {
    throw new Error('The spreadsheet would pass ' + VOH.CELL_STOP + ' cells (Google limit 10,000,000). Delete the rows of an old month in "' +
      VOH.SHEET + '" (they are one block, in date order) and run the load again. Nothing was written.');
  }
  if (extraRows) sh.insertRowsAfter(sh.getMaxRows(), extraRows);
  if (cut <= last) {
    sh.getRange(cut, 1, last - cut + 1, N).clearContent();
    sh.getRange(cut, IC, last - cut + 1, 1).clearContent();           // rewritten below, row by row, with each row's own flag
  }
  for (var s = 0; s < tail.length; s += VOH.WRITE_CHUNK) {
    var part = tail.slice(s, s + VOH.WRITE_CHUNK);
    sh.getRange(cut + s, 1, part.length, N).setValues(part.map(function (r) { return r.v; }));
    if (part.some(function (r) { return r.ign !== '' && r.ign !== null && r.ign !== undefined; })) {
      sh.getRange(cut + s, IC, part.length, 1).setValues(part.map(function (r) { return [r.ign === undefined || r.ign === null ? '' : r.ign]; }));
    }
  }
  return { untouched: cut - 2, keptAfter: keptAfter.length, written: tail.length, total: cut - 2 + tail.length, reordered: reordered,
           ignCarried: carried, ignDropped: flaggedN - carried };
}

/** After a load: are the formula columns producing values, and are all providers in the roster? */
function VOH_postCheck_(sh) {
  var top = sh.getRange('L1:Z2').getDisplayValues();
  var errs = [];
  top.forEach(function (row) { row.forEach(function (v, j) { if (/^#(REF|N\/A|ERROR|VALUE|NAME)/.test(String(v))) errs.push(VOH_colName_(VOH.FIRST_FORMULA_COL + j) + ':' + v); }); });
  var last = VOH_lastDataRow_(sh), unmapped = 0;
  if (last >= 2) {
    sh.getRange(2, 13, last - 1, 1).getValues().forEach(function (r) { if (r[0] === 'Not in roster') unmapped++; });   // M = Agent Name
  }
  if (errs.length) return 'ERROR in formula columns: ' + errs.slice(0, 5).join(', ') + ' — run repairVoyceOnlineHoursFormulas()';
  return unmapped ? ('OK; ' + unmapped + ' rows have a Provider Id that is not in SD Dis (see _Control!H)') : 'OK';
}

/* ============================== TRIGGER ==============================
 * No code here on purpose. Creating or deleting triggers from code needs the OAuth scope
 * script.scriptapp, which is not in the app's manifest; adding it would make every web-app
 * user authorise again. Create the hourly trigger in the Triggers page instead:
 *   Triggers (clock icon) → Add Trigger → function vohScheduledHourly → deployment Head →
 *   event source Time-driven → Hour timer → Every hour → Save.
 * To stop it: Triggers page → ⋮ → Delete trigger.
 */

/* ============================== PROBE (no writes) ============================== */
/** Run once from the editor before go-live; logs the shapes the loader will receive. */
function TEST_vohProbe(day) {
  requireSetupAccess_();
  day = day || VOH_addDays_(VOH_today_(), -1);
  var res = runAutomatedVoyceReports(day, day);
  var ot = VOH_table_(res.onlineTime, 'report 12'), pf = VOH_table_(res.performance, 'cleaned');
  Logger.log('result keys: ' + Object.keys(res).join(', '));
  Logger.log('report 12: ' + ot.rows.length + ' rows; headers (' + ot.header.length + '): ' + ot.header.join(' | '));
  Logger.log('report 12 first row: ' + JSON.stringify(ot.rows[0]));
  Logger.log('cleaned: ' + pf.rows.length + ' rows; headers: ' + pf.header.join(' | '));
  Logger.log('cleaned first row: ' + JSON.stringify(pf.rows[0]));
  var built = VOH_buildRows_(res.onlineTime, res.performance);
  Logger.log('BUILD OK: ' + built.online.length + ' online rows, ' + built.calls.length + ' call rows. First online: ' +
    JSON.stringify(built.online[0] && built.online[0].v) + ' First call: ' + JSON.stringify(built.calls[0] && built.calls[0].v));
}

/* ============================== HELPERS ============================== */
/** Entry points return text to the app, but the editor only shows what is logged, so log it too. */
function VOH_say_(msg) { Logger.log(msg); return msg; }

function VOH_ss_() {
  var id = PropertiesService.getScriptProperties().getProperty(VOH.PROP_ID);
  if (!id) throw new Error('Script Property ' + VOH.PROP_ID + ' is not set (id of the Voyce Online Hours spreadsheet).');
  return SpreadsheetApp.openById(id);
}
function VOH_sheet_() {
  var sh = VOH_ss_().getSheetByName(VOH.SHEET);
  if (!sh) throw new Error('Sheet "' + VOH.SHEET + '" not found. Run setupVoyceOnlineHoursSheet() first.');
  return sh;
}
function VOH_setControl_(a1, v) {
  var c = VOH_ss_().getSheetByName(VOH.CONTROL);
  if (c) c.getRange(a1).setValue(v);
}
function VOH_today_() { return Utilities.formatDate(new Date(), VOH.TZ, 'yyyy-MM-dd'); }
function VOH_cells_(ss) {
  return ss.getSheets().reduce(function (n, sh) { return n + sh.getMaxRows() * sh.getMaxColumns(); }, 0);
}
function VOH_log_(row) { var l = VOH_ss_().getSheetByName(VOH.LOG); if (l) l.appendRow(row); }
function VOH_who_() { try { return currentUserEmail_() || 'trigger'; } catch (e) { return 'trigger'; } }

function VOH_lastDataRow_(sh) {
  var max = sh.getMaxRows();
  if (max < 2) return 1;
  var col = sh.getRange(2, 1, max - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) if (col[i][0] !== '' && col[i][0] !== null) return i + 2;
  return 1;
}

/** Accepts {columns:[{header}],rows}, {columns:[str]}, {headers|header,rows}, or [[header...],[row...]]. */
function VOH_table_(x, label) {
  if (!x) throw new Error('The automation returned no ' + label + '.');
  var header, rows;
  if (Array.isArray(x)) { header = x[0]; rows = x.slice(1); }
  else {
    var cols = x.columns || x.headers || x.header;
    if (!cols && x.table) return VOH_table_(x.table, label);
    if (!cols) throw new Error('Cannot read ' + label + ': keys are ' + Object.keys(x).join(', '));
    header = cols.map(function (c) { return typeof c === 'string' ? c : (c.header || c.name || c.label || ''); });
    rows = x.rows || x.data || [];
  }
  if (rows.length && !Array.isArray(rows[0])) {                        // rows as objects keyed by header
    rows = rows.map(function (o) { return header.map(function (h) { return o[h]; }); });
  }
  header = header.map(function (h) { return String(h === null || h === undefined ? '' : h).replace(/^﻿/, '').trim(); });
  return { header: header, rows: rows };
}

function VOH_norm_(h) { return String(h).toLowerCase().replace(/[^a-z0-9%\/]/g, ''); }
function VOH_expectHeaders_(got, want, label) {
  var bad = [];
  for (var i = 0; i < want.length; i++) if (VOH_norm_(got[i] || '') !== VOH_norm_(want[i])) bad.push('#' + (i + 1) + ' got "' + (got[i] || '') + '" expected "' + want[i] + '"');
  if (got.length !== want.length) bad.push('column count ' + got.length + ' vs ' + want.length);
  if (bad.length) throw new Error(label + ' headers do not match: ' + bad.slice(0, 6).join('; '));
}

function VOH_toNum_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  var s = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (s === '') return '';
  var n = Number(s);
  return isNaN(n) ? String(v) : n;
}

/** New York wall-clock Date from parts. Rejects impossible parts (Utilities.parseDate is lenient and would roll them over). */
function VOH_ny_(y, mo, d, h, mi, s) {
  h = h || 0; mi = mi || 0; s = s || 0;
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= dim && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59)) {
    throw new Error('impossible date/time ' + [y, mo, d].join('-') + ' ' + [h, mi, s].join(':'));
  }
  var p = function (n) { n = String(n); return n.length < 2 ? '0' + n : n; };
  return Utilities.parseDate(y + '-' + p(mo) + '-' + p(d) + 'T' + p(h || 0) + ':' + p(mi || 0) + ':' + p(s || 0),
    VOH.TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

/** Strict: Date, Excel serial, epoch ms, "M/D/YYYY[ h:mm[:ss][ AM|PM]]" or ISO. Anything else stops the run. */
function VOH_toDate_(v, where) {
  try { return VOH_toDateInner_(v); } catch (e) {
    var shown = v instanceof Date ? 'invalid Date' : String(v === null || v === undefined ? '' : v).trim();
    throw new Error('Unreadable date "' + shown + '" in ' + where + ' (' + e.message + '). Load stopped; nothing was written.');
  }
}
function VOH_toDateInner_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'number') {
    if (v > 1e11) return new Date(v);
    if (v > 20000 && v < 80000) {                                      // Excel serial, NY wall clock
      var ms = Math.round((v - 25569) * 86400000), w = new Date(ms);
      return VOH_ny_(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());
    }
  }
  var s = String(v === null || v === undefined ? '' : v).trim(), m;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?)?$/.exec(s))) {
    var h = m[4] ? Number(m[4]) : 0;
    if (m[7]) { var pm = /p/i.test(m[7]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return VOH_ny_(Number(m[3]), Number(m[1]), Number(m[2]), h, Number(m[5] || 0), Number(m[6] || 0));
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(s))) {
    return VOH_ny_(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  throw new Error('format not recognised');
}

function VOH_day_(d) { return d instanceof Date ? Utilities.formatDate(d, VOH.TZ, 'yyyy-MM-dd') : ''; }
function VOH_addDays_(ymd, n) {
  var p = ymd.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function VOH_checkRange_(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) throw new Error('Dates must be yyyy-MM-dd.');
  if (from > to) throw new Error('From is after To.');
  var days = (Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8))) / 86400000 + 1;
  if (days > VOH.MAX_DAYS) throw new Error('At most ' + VOH.MAX_DAYS + ' days per load.');
}
function VOH_colName_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }