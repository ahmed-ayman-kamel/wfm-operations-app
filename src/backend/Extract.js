/**
 * Extract.gs — NEW FILE. Server side of Reporting → "Extract Data".
 * -----------------------------------------------------------------------------
 * Lets permitted people download the raw data behind each dashboard without opening Google Sheets.
 * The page (the Extract Data part of Reporting_HTML.html) builds the CSV / Excel files in the browser
 * from what these functions return, with the same exporter the Reporting tools already use.
 *
 * WHAT IS EXPOSED: only the datasets listed in EXTRACT_reports_() below — the raw tabs each dashboard is
 * built from. Rosters (Database / SD Dis / Data Base), _Control, _Load Log, _Flags, Aliases, drafts and
 * backups are never listed. Adding a dashboard or a dataset later = one entry below; nothing else changes.
 *
 * WHO: the Reporting roles (EXTRACT.ROLES: Admin, Manager, RTM; Operations does not use Reporting) AND the
 * roles of that dashboard in DASHBOARDS (Dashboards.gs). Checked here on every call, on top of the
 * API_FUNCS_ gate in Api.gs. The browser is never the security boundary.
 *
 * HOW (read only; nothing is ever written to a source spreadsheet):
 *   getExtractCatalog()                     reports this person may extract from (no spreadsheet opened)
 *   getExtractReport(reportId)              live details: rows, columns, headers, number formats, preview,
 *                                           last load, and a consistency stamp
 *   extractReadPage(reportId, datasetId, mode, startRow, rowCount, cols)
 *                                           one block of rows. mode 'values' = the cell values (numbers stay
 *                                           numbers, dates/times as spreadsheet serials) for Excel;
 *                                           mode 'display' = exactly what the sheet shows, for CSV
 *   extractCheck(reportId, stamp, info)     after the last block: was the data reloaded (or is a load running)
 *                                           while it was being read? The page only saves the file when not.
 *                                           One Audit Log line per finished download (Api.gs).
 * Blocks are read with the Sheets API (advanced service "Sheets", already enabled in appsscript.json);
 * if that service is not available the same values are read with SpreadsheetApp instead.
 *
 * Depends on: Dashboards.gs (DASHBOARDS, dashRole_, dashRoleAllowed_), Auth.gs (requireRegistered_),
 * VoyceOnlineHours.gs (VOH), Adherence.gs + Dash_Adherence.gs (ADH, ADHD_stamp_), Mvcc.gs + Dash_Mvcc.gs
 * (MVCC, MVD_stamp_), Acw.gs + Dash_Acw.gs (ACW, ACD_stamp_). No new OAuth scope.
 */

var EXTRACT = {
  ROLES: ['Admin', 'Manager', 'RTM'],     // same people as the Reporting section
  PAGE_MAX_CELLS: 250000,                 // per extractReadPage call (the page asks for about 120,000)
  MAX_COLS: 200,
  PREVIEW_ROWS: 5,
  FORMAT_PROBE_ROWS: 50,                  // number format of a column = that of its first filled cell in these rows
  NO_API_KEY: 'EXTRACT_NO_SHEETS_API'
};

/**
 * Report → raw datasets. Built in a function (not at load time) because VOH / ADH / MVCC / ACW live in other files.
 * Each dataset: id (stable, used by the page), sheet (the tab, from the module's own constants), title, description,
 * updatedCell / countCell (the module's _Control cells: last load, and the row count written by that load).
 */
function EXTRACT_reports_() {
  return [
    {
      id: 'voyce', dashboard: 'voyce', workbook: 'Voyce DB', prop: VOH.PROP_ID, control: VOH.CONTROL, runFlag: VOH.RUN_FLAG,
      icon: 'activity',
      stamp: function (ss) {                                    // same value as VOHD_stamp_(), from this spreadsheet object
        var c = ss.getSheetByName(VOH.CONTROL), v = c ? c.getRange('B2').getValue() : '';
        return String(v instanceof Date ? v.getTime() : v || 'none');
      },
      datasets: [
        { id: 'online_hours', sheet: VOH.SHEET, title: 'Voyce Online Hours', updatedCell: 'B2', countCell: 'B5',
          description: 'Online sessions with offline codes, and calls with accepted codes and short calls, per interpreter from Voyce. Includes the roster columns, paid hours and talk time, and the Ign column.' }
      ]
    },
    {
      id: 'adherence', dashboard: 'adherence', workbook: 'Adherence Data', prop: ADH.PROP_ID, control: ADH.CONTROL, runFlag: ADH.RUN_FLAG,
      icon: 'clock',
      stamp: function (ss) { return ADHD_stamp_(ss); },
      datasets: [
        { id: 'raw_data', sheet: ADH.SHEET, title: 'Adherence Raw Data', updatedCell: 'B2', countCell: 'B5',
          description: 'NICE adherence by agent, day and scheduled activity (scheduled, actual, in and out of adherence), with the Database lookups: language, supervisor, queue, platform and SDACMs.' }
      ]
    },
    {
      id: 'mvcc', dashboard: 'mvcc', workbook: 'MVCC Data', prop: MVCC.PROP_ID, control: MVCC.CONTROL, runFlag: MVCC.RUN_FLAG,
      icon: 'activity',
      stamp: function (ss) { return MVD_stamp_(ss); },
      datasets: [
        { id: 'mvcc_data', sheet: MVCC.DATA, title: 'MVCC Data', updatedCell: 'B2', countCell: 'B5',
          description: 'One row per agent and day from Sisense: assigned, accepted, timed out and cancelled calls, with paid hour, talk time, short calls and the roster columns.' },
        { id: 'aht', sheet: MVCC.AHT, title: 'AHT', updatedCell: 'B2', countCell: 'B6',
          description: 'One row per call from Sisense with its duration in minutes and seconds. Feeds Talk time.' },
        { id: 'short_calls', sheet: MVCC.SHORT, title: 'Short Calls', updatedCell: 'B2', countCell: 'B7',
          description: 'Short calls from Sisense, one row per call, with duration, language and status. Feeds Short calls.' },
        { id: 'paid_hours', sheet: MVCC.PAID, title: 'Paid Hours', updatedCell: 'B9', countCell: 'B11',
          description: 'NICE time utilization by agent, day and activity. Feeds Paid hour.' }
      ]
    },
    {
      id: 'acw', dashboard: 'acw', workbook: 'ACW Data', prop: ACW.PROP_ID, control: ACW.CONTROL, runFlag: ACW.RUN_FLAG,
      icon: 'clock',
      stamp: function (ss) { return ACD_stamp_(ss); },
      datasets: [
        { id: 'call_events', sheet: ACW.CE, title: 'Call Events', updatedCell: 'B2', countCell: 'B5',
          description: 'One row per agent and day from Sisense: assigned, accepted, timed out and cancelled calls, with the roster columns.' },
        { id: 'acw_raw', sheet: ACW.RAW, title: 'ACW Raw Data', updatedCell: 'B6', countCell: 'B9',
          description: 'NICE after-call work time by agent and day, with the roster columns.' }
      ]
    }
  ];
}

/* ============================== PUBLIC ============================== */

/** Reports this person may extract from. Cheap: no spreadsheet is opened. */
function getExtractCatalog() {
  var role = EXTRACT_requireRole_();
  var reports = EXTRACT_reports_().filter(function (r) { return EXTRACT_canOpen_(r, role); }).map(EXTRACT_public_);
  return { ok: true, role: role, reports: reports };
}

/** Live details of one report's datasets (opens its spreadsheet once; small reads only). */
function getExtractReport(reportId) {
  var r = EXTRACT_requireReport_(reportId);
  var ss = EXTRACT_open_(r);
  var ctl = EXTRACT_control_(ss, r);
  var datasets = r.datasets.map(function (d) { return EXTRACT_describe_(ss, d, ctl); });
  return {
    ok: true,
    report: EXTRACT_public_(r),
    workbook: ss.getName(),
    timeZone: ss.getSpreadsheetTimeZone(),
    stamp: r.stamp(ss),
    running: EXTRACT_running_(r),
    checkedAt: Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'),
    datasets: datasets
  };
}

/**
 * One block of rows (sheet rows startRow .. startRow+rowCount-1, columns A .. cols).
 * Always returns exactly rowCount rows of exactly cols cells ('' for empty), so the page can check it got everything.
 */
function extractReadPage(reportId, datasetId, mode, startRow, rowCount, cols) {
  var r = EXTRACT_requireReport_(reportId);
  var d = EXTRACT_dataset_(r, datasetId);
  startRow = EXTRACT_int_(startRow, 'start row'); rowCount = EXTRACT_int_(rowCount, 'row count'); cols = EXTRACT_int_(cols, 'column count');
  if (startRow < 2) throw new Error('Rows start after the header row.');
  if (rowCount < 1 || cols < 1 || cols > EXTRACT.MAX_COLS) throw new Error('Invalid block size.');
  if (rowCount * cols > EXTRACT.PAGE_MAX_CELLS) throw new Error('The block is too large; ask for fewer rows at a time.');
  if (mode !== 'values' && mode !== 'display') throw new Error('Unknown read mode.');

  var id = EXTRACT_ssId_(r), rows = null, via = 'api';
  if (EXTRACT_apiAvailable_()) {
    try { rows = EXTRACT_readApi_(id, d.sheet, startRow, rowCount, cols, mode); }
    catch (e) {
      if (EXTRACT_isApiOff_(e)) CacheService.getScriptCache().put(EXTRACT.NO_API_KEY, '1', 6 * 3600);   // Sheets API off: use SpreadsheetApp
      else if (!EXTRACT_isQuota_(e)) throw new Error('Could not read "' + d.sheet + '" (rows ' + startRow + '–' + (startRow + rowCount - 1) + '): ' + EXTRACT_msg_(e));
      rows = null;                                                              // quota reached (all reads run on the owner's account): this block via SpreadsheetApp
    }
  }
  if (!rows) { rows = EXTRACT_readSheet_(r, d, startRow, rowCount, cols, mode); via = 'sheet'; }

  var out = new Array(rowCount);
  for (var i = 0; i < rowCount; i++) {
    var src = rows[i] || [], row = new Array(cols);
    for (var c = 0; c < cols; c++) { var v = src[c]; row[c] = (v === undefined || v === null) ? '' : v; }
    out[i] = row;
  }
  return { ok: true, start: startRow, count: rowCount, cols: cols, mode: mode, via: via, rows: out };
}

/**
 * Called once after the last block, before the file is saved. consistent = false when the data was reloaded
 * (the dashboard's load stamp changed) or a load is running, i.e. the blocks may mix old and new rows.
 * info = { datasets: [id], rows: n, format } is only used for the Audit Log line.
 */
function extractCheck(reportId, stamp, info) {
  var r = EXTRACT_requireReport_(reportId);
  var ss = EXTRACT_open_(r), now = r.stamp(ss), running = EXTRACT_running_(r);
  return { ok: true, consistent: String(now) === String(stamp) && !running, changed: String(now) !== String(stamp), running: running, stamp: now };
}

/* ============================== ACCESS ============================== */

function EXTRACT_requireRole_() {
  requireRegistered_();
  var role = dashRole_();
  if (!EXTRACT_inList_(EXTRACT.ROLES, role)) throw new Error('Unauthorized: Extract Data is not available for the ' + (role || 'current') + ' role.');
  return role;
}

function EXTRACT_canOpen_(r, role) {
  var dash = (typeof DASHBOARDS !== 'undefined') ? DASHBOARDS[r.dashboard] : null;
  if (!dash || !dashRoleAllowed_(dash, role)) return false;               // same roles as the dashboard itself
  return EXTRACT_inList_(r.roles || EXTRACT.ROLES, role);
}

function EXTRACT_requireReport_(reportId) {
  var role = EXTRACT_requireRole_();
  var id = String(reportId || '');
  var r = EXTRACT_reports_().filter(function (x) { return x.id === id; })[0];
  if (!r) throw new Error('Unknown report.');
  if (!EXTRACT_canOpen_(r, role)) throw new Error('Unauthorized: raw data for ' + EXTRACT_title_(r) + ' is not available for your role.');
  return r;
}

function EXTRACT_dataset_(r, datasetId) {
  var id = String(datasetId || '');
  var d = r.datasets.filter(function (x) { return x.id === id; })[0];
  if (!d) throw new Error('Unknown dataset for ' + EXTRACT_title_(r) + '.');
  return d;
}

function EXTRACT_inList_(list, v) {
  var s = String(v || '').toLowerCase();
  if (!s) return false;
  for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === s) return true;
  return false;
}

/* ============================== DETAILS ============================== */

function EXTRACT_title_(r) { return (typeof DASHBOARDS !== 'undefined' && DASHBOARDS[r.dashboard] && DASHBOARDS[r.dashboard].title) || r.id; }

/** What the page shows before anything is opened. Never includes spreadsheet ids or Script Property names. */
function EXTRACT_public_(r) {
  var dash = (typeof DASHBOARDS !== 'undefined' && DASHBOARDS[r.dashboard]) || {};
  return {
    id: r.id, dashboard: r.dashboard, title: dash.title || r.id, subtitle: dash.subtitle || '', icon: r.icon || dash.icon || '',
    workbook: r.workbook,
    datasets: r.datasets.map(function (d) { return { id: d.id, title: d.title, sheet: d.sheet, description: d.description }; })
  };
}

function EXTRACT_ssId_(r) {
  var id = PropertiesService.getScriptProperties().getProperty(r.prop);
  if (!id) throw new Error('The ' + r.workbook + ' spreadsheet is not set up in the app yet. Ask the app owner (Script Property ' + r.prop + ' is missing).');
  return id;
}

function EXTRACT_open_(r) {
  var id = EXTRACT_ssId_(r);
  try { return SpreadsheetApp.openById(id); }
  catch (e) {
    throw new Error('The app could not open the ' + r.workbook + ' spreadsheet (' + EXTRACT_msg_(e) + '). ' +
      'Ask the app owner to check that the spreadsheet still exists and that the app\'s owner account can open it.');
  }
}

function EXTRACT_running_(r) {
  try { return !!(r.runFlag && CacheService.getScriptCache().get(r.runFlag)); } catch (e) { return false; }
}

/** _Control A1:B30 as displayed, by cell ('B2' → '10/19/2026'). {} when the tab is missing. */
function EXTRACT_control_(ss, r) {
  var out = {}, c = r.control ? ss.getSheetByName(r.control) : null;
  if (!c) return out;
  var v = c.getRange('B1:B30').getDisplayValues();
  for (var i = 0; i < v.length; i++) out['B' + (i + 1)] = String(v[i][0] || '').trim();
  return out;
}

function EXTRACT_describe_(ss, d, ctl) {
  var base = { id: d.id, title: d.title, sheet: d.sheet, description: d.description,
               updated: ctl[d.updatedCell] || '', expectedRows: EXTRACT_count_(ctl[d.countCell]) };
  var sh = ss.getSheetByName(d.sheet);
  if (!sh) {
    base.available = false;
    base.error = 'The tab "' + d.sheet + '" was not found in the ' + ss.getName() + ' spreadsheet. It may have been renamed or deleted; nothing was substituted for it.';
    return base;
  }
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastCol > EXTRACT.MAX_COLS) {
    base.available = false;
    base.error = 'The tab "' + d.sheet + '" has ' + lastCol + ' columns; extraction supports up to ' + EXTRACT.MAX_COLS + '.';
    return base;
  }
  base.available = true;
  base.rows = Math.max(0, lastRow - 1);                               // upper bound; the page drops trailing blank rows
  base.cols = lastCol;
  base.header = []; base.formats = []; base.preview = [];
  if (lastRow < 1 || lastCol < 1) return base;

  var probe = Math.min(lastRow, 1 + EXTRACT.FORMAT_PROBE_ROWS);
  var rng = sh.getRange(1, 1, probe, lastCol);
  var disp = rng.getDisplayValues(), vals = rng.getValues(), fmts = rng.getNumberFormats();
  base.header = disp[0].map(function (h) { return String(h); });
  for (var c = 0; c < lastCol; c++) {
    var f = '';
    for (var i = 1; i < probe; i++) if (vals[i][c] !== '' && vals[i][c] !== null) { f = fmts[i][c]; break; }
    base.formats.push(EXTRACT_excelFormat_(f));
  }
  base.preview = disp.slice(1, 1 + EXTRACT.PREVIEW_ROWS);
  return base;
}

/** Sheets number format → the same format for Excel ('' = General). Sheets reports General/automatic as '0.###############'. */
function EXTRACT_excelFormat_(f) {
  f = String(f || '').trim();
  if (!f || /^general$/i.test(f) || /^0\.#+$/.test(f)) return '';
  return f;
}

function EXTRACT_count_(s) {
  var n = Number(String(s || '').replace(/[,\s]/g, ''));
  return isFinite(n) && n >= 0 && String(s || '').trim() !== '' ? Math.round(n) : null;
}

/* ============================== READING ============================== */

function EXTRACT_apiAvailable_() {
  try {
    if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) return false;
    return !CacheService.getScriptCache().get(EXTRACT.NO_API_KEY);
  } catch (e) { return false; }
}

function EXTRACT_isApiOff_(e) {
  return /has not been used|is disabled|not been enabled|SERVICE_DISABLED|accessNotConfigured/i.test(EXTRACT_msg_(e));
}

function EXTRACT_isQuota_(e) { return /429|Quota|Rate Limit|RESOURCE_EXHAUSTED/i.test(EXTRACT_msg_(e)); }

/** Sheets API read; up to 3 tries on temporary server errors. Quota errors are passed up at once (the caller falls back). */
function EXTRACT_readApi_(id, sheet, startRow, rowCount, cols, mode) {
  var range = EXTRACT_a1_(sheet, startRow, rowCount, cols);
  var opts = { majorDimension: 'ROWS', valueRenderOption: mode === 'display' ? 'FORMATTED_VALUE' : 'UNFORMATTED_VALUE',
               dateTimeRenderOption: 'SERIAL_NUMBER' };
  for (var attempt = 1; ; attempt++) {
    try {
      var res = Sheets.Spreadsheets.Values.get(id, range, opts);
      return (res && res.values) || [];
    } catch (e) {
      var temporary = /500|502|503|backendError|internal error|timed out/i.test(EXTRACT_msg_(e));
      if (!temporary || attempt >= 3 || EXTRACT_isApiOff_(e) || EXTRACT_isQuota_(e)) throw e;
      Utilities.sleep(1200 * attempt);
    }
  }
}

/** SpreadsheetApp read (used only when the Sheets API service is not available). Dates/times → spreadsheet serials. */
function EXTRACT_readSheet_(r, d, startRow, rowCount, cols, mode) {
  var ss = EXTRACT_open_(r), sh = ss.getSheetByName(d.sheet);
  if (!sh) throw new Error('The tab "' + d.sheet + '" was not found in the ' + ss.getName() + ' spreadsheet.');
  var maxRow = sh.getMaxRows(), maxCol = sh.getMaxColumns();
  var n = Math.min(rowCount, maxRow - startRow + 1), w = Math.min(cols, maxCol);
  if (n < 1 || w < 1) return [];
  var rng = sh.getRange(startRow, 1, n, w);
  if (mode === 'display') return rng.getDisplayValues();
  var tz = ss.getSpreadsheetTimeZone(), vals = rng.getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    for (var c = 0; c < row.length; c++) if (row[c] instanceof Date) row[c] = EXTRACT_serial_(row[c], tz);
  }
  return vals;
}

var EXTRACT_offCache_ = {};
/** Spreadsheet serial (days since 1899-12-30) of a Date's wall-clock time in tz, the value the cell holds. */
function EXTRACT_serial_(d, tz) {
  var t = d.getTime();
  if (isNaN(t)) return '';
  var key = tz + '|' + Math.floor(t / 3600000), off = EXTRACT_offCache_[key];
  if (off === undefined) {
    var m = Utilities.formatDate(new Date(t), tz, 'yyyy-MM-dd HH:mm:ss').match(/^(-?\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/);
    off = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Math.floor(t / 1000) * 1000;
    EXTRACT_offCache_[key] = off;
  }
  return (t + off) / 86400000 + 25569;
}

/* ============================== SMALL HELPERS ============================== */

function EXTRACT_col_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function EXTRACT_a1_(sheet, startRow, rowCount, cols) {
  return "'" + String(sheet).replace(/'/g, "''") + "'!A" + startRow + ':' + EXTRACT_col_(cols) + (startRow + rowCount - 1);
}
function EXTRACT_int_(v, label) {
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n) throw new Error('Invalid ' + label + '.');
  return n;
}
function EXTRACT_msg_(e) { return String((e && e.message) || e); }
