/**
 * Reporting.gs
 * Server side of the "Reporting" section: a small, extensible framework for report tools, plus the
 * first tool, "Voyce Performance Clean Report".
 * Client side: Reporting_HTML.html. (It cannot be called "Reporting" because Apps Script does not
 * allow an .html file and a .gs file to share one base name in the same project.)
 *
 * LAYERS (each one only talks to the one below it)
 *   1. File input & validation   REPORTING_parseUploadedFile_ (files, or cells pasted from Excel / Google Sheets)
 *   2. Parsing                   REPORTING_parseDelimitedText_ (CSV/TSV via Utilities.parseCsv),
 *                                REPORTING_parseXlsx_ (Drive conversion; every sheet of a workbook)
 *   3. Recognition & columns     REPORTING_classifyHeaders_ + REPORTING_assignRoles_ decide which table is which
 *                                report from its columns alone (names and order do not matter);
 *                                REPORTING_resolveColumnIndices_ finds each column by header name
 *   4. Normalization             REPORTING_prepareVoyceTable_, REPORTING_prepareShortCallsTable_:
 *                                text dates -> real Date objects, CSV number text -> the value a Sheet would hold
 *   5. Business logic            REPORTING_normalizeAndFilterVoyceData_, REPORTING_resolveDuplicateGroups_,
 *                                REPORTING_buildShortCallsIndex_, REPORTING_buildCleanedOutputRows_
 *                                (a line-for-line port of the production Voyce pipeline, phases 3-7)
 *   6. Result generation         REPORTING_buildResultPayload_ (plain strings/numbers; no Date crosses the wire)
 *   7. Error handling            every layer throws a specific, readable Error; nothing is skipped silently
 *   8. UI                        Reporting_HTML.html calls getReportingCatalog and runVoycePerformanceReport.
 *                                CSV and XLSX files are built in the browser from the result, so exporting
 *                                needs no second server call and no extra permission.
 *
 * TIME ZONE RULE (the one thing that is easy to get wrong here)
 * The RequestTime shown and exported must be the SAME wall-clock time that is in the uploaded file.
 * The production pipeline reads and writes inside one spreadsheet, so that always held there. Here,
 * every Date is anchored to America/New_York (REPORTING_CONFIG.TIMEZONE) at every step:
 *   - CSV text is read as New York wall-clock time,
 *   - a converted .xlsx is switched to New York time before its values are read,
 *   - display strings and Excel date serials are produced in New York time.
 * The person's own time zone, the script's time zone and the browser's time zone never take part.
 *
 * Validation notes (column order, blank padding rows, CSV-only handling) are in
 * WFM_App_Documentation.md, section 5.6.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const REPORTING_CONFIG = {
  TIMEZONE: 'America/New_York',
  DISPLAY_FORMAT: 'yyyy-MM-dd HH:mm:ss',
  MAX_FILE_BYTES: 20 * 1024 * 1024,        // per uploaded file
  TEMP_FOLDER_NAME: 'WFM Operations - Reporting Temp',
  TEMP_FOLDER_PROP: 'WFM_REPORTING_TEMP_FOLDER_ID', // per user (User Properties)
  STALE_TEMP_MS: 60 * 60 * 1000,           // leftovers older than this are removed
  MAX_FILES: 3,                            // per run: the two reports, as 1 workbook or 2-3 files
  MAX_TOTAL_BYTES: 30 * 1024 * 1024,
  PROBE_ROWS: 20,                          // the header row must be within the first 20 non-blank rows
  // A table that has these columns is a previous Cleaned RESULT (for example the "Cleaned" tab of the
  // production workbook), never a source report. It has a Transaction Id column, so without this
  // rule it would be taken for a Short Calls export.
  RESULT_MARKER_HEADERS: ['accepted codes', 'short calls'],
  // A table with at least this many of the 7 Voyce columns (but not all) is reported as an
  // incomplete Voyce export, instead of being taken for a Short Calls export.
  NEAR_VOYCE_MIN: 4,

  // Header aliases, verbatim from the production script (case and surrounding spaces ignored).
  VOYCE_HEADERS: {
    INTERPRETER_NAME: ['interpreter name', 'interpretername'],
    INTERPRETER_ID: ['interpreter id', 'interpreterid'],
    TRANSACTION_ID: ['transaction id', 'transactionid'],
    REQUEST_TIME: ['requesttime (eastern standard time)', 'requesttime', 'request time'],
    ASSIGNED_TIME: ['assignedtointerpretertime', 'assigned to interpreter time'],
    ACCEPTED_TIME: ['acceptedbyinterpretertime', 'accepted by interpreter time'],
    SECONDS_TO_ANSWER: ['secondstoanswer', 'seconds to answer']
  },
  SHORT_CALLS_HEADERS: {
    TRANSACTION_ID: ['transactionid', 'transaction id', 'transaction_id']
  },
  // Names used in error messages.
  HEADER_LABELS: {
    INTERPRETER_NAME: 'Interpreter Name', INTERPRETER_ID: 'Interpreter Id', TRANSACTION_ID: 'Transaction Id',
    REQUEST_TIME: 'RequestTime (Eastern Standard Time)', ASSIGNED_TIME: 'AssignedToInterpreterTime',
    ACCEPTED_TIME: 'AcceptedByInterpreterTime', SECONDS_TO_ANSWER: 'SecondsToAnswer'
  },

  // Output columns in the production script's exact order (CONFIG.OUTPUT_HEADERS), which is also the
  // order of the real sample's "Cleaned" sheet. `type` drives how the browser writes the XLSX cell,
  // matching the cell types found in that sample: numbers stay numbers, IDs are text ('@'),
  // RequestTime is a real date formatted yyyy-mm-dd hh:mm:ss, Short Calls is an integer ('0').
  VOYCE_OUTPUT_COLUMNS: [
    { header: 'Interpreter Id', type: 'auto' },
    { header: 'Interpreter Name', type: 'text' },
    { header: 'RequestTime (Eastern Standard Time)', type: 'datetime', numberFormat: 'yyyy-mm-dd hh:mm:ss' },
    { header: 'Accepted Codes', type: 'text', numberFormat: '@' },
    { header: 'Transaction Id', type: 'text', numberFormat: '@' },
    { header: 'Short Calls', type: 'integer', numberFormat: '0' }
  ],
  VOYCE_SHEET_NAME: 'Cleaned'
};

/** Report tools shown in the Reporting picker. Add an entry here to add a tool (see the doc, 5.6). */
const REPORTING_REGISTRY = [
  {
    id: 'voyce_clean',
    title: 'Voyce Performance Report',
    description: 'Pick the dates and fetch both reports in one go: the cleaned Voyce Performance Report (Voyce Time To Answer + Sisense Short Calls, same rules as the production Voyce pipeline) and the Provider Online Time Detail Report. You can still drop the exports yourself.',
    icon: 'phone',
    // Sent to the browser so it can recognize each file before Process. The server checks again itself.
    inputs: [
      { role: 'voyce', label: 'Voyce Performance export', headers: REPORTING_CONFIG.VOYCE_HEADERS, labels: REPORTING_CONFIG.HEADER_LABELS },
      { role: 'shortCalls', label: 'Short Calls export', headers: REPORTING_CONFIG.SHORT_CALLS_HEADERS, labels: REPORTING_CONFIG.HEADER_LABELS }
    ],
    resultHeaders: REPORTING_CONFIG.RESULT_MARKER_HEADERS,
    nearVoyceMin: REPORTING_CONFIG.NEAR_VOYCE_MIN
  }
];

function getReportingCatalog() {
  requireRegistered_();
  return { reports: REPORTING_REGISTRY };
}

// ============================================================================
// LAYER 1-2: FILE INPUT, VALIDATION & PARSING
// ============================================================================

const REPORTING_XLSX_MIME_ = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const REPORTING_XLS_MIME_ = 'application/vnd.ms-excel';
const REPORTING_SHEET_MIME_ = 'application/vnd.google-apps.spreadsheet';

function REPORTING_isBlankCell_(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Removes rows where EVERY cell is empty (export padding; the validation sample had thousands).
 * This runs before any business rule. A row with some data but a blank Transaction Id is NOT removed
 * here; the business logic skips it, exactly as the production script does.
 * Returns the kept rows plus their 1-based row numbers in the original file, for error messages.
 */
function REPORTING_dropBlankRows_(table) {
  const rows = [];
  const rowNumbers = [];
  for (let i = 0; i < table.length; i++) {
    const row = table[i];
    let hasData = false;
    for (let j = 0; j < row.length; j++) {
      if (!REPORTING_isBlankCell_(row[j])) { hasData = true; break; }
    }
    if (hasData) { rows.push(row); rowNumbers.push(i + 1); }
  }
  return { rows: rows, rowNumbers: rowNumbers };
}

function REPORTING_extensionOf_(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function REPORTING_tableLabel_(name, sheetName) {
  return sheetName ? '"' + name + '" (sheet "' + sheetName + '")' : '"' + name + '"';
}

/**
 * Turns all rows of a file or of one sheet into a table.
 * Header row: the first of the first PROBE_ROWS non-blank rows that is recognized as a report header
 * (so a title line such as "Report generated on ..." above the headers is skipped); when none is
 * recognized, the first non-blank row. Rows above the header row are not data.
 * format: 'text' (CSV, TSV, pasted cells: every cell arrives as text) or 'xlsx' (typed cells).
 * role: see REPORTING_classifyHeaders_; 'empty' when there is no data at all.
 */
function REPORTING_buildTable_(allRows, name, sheetName, format) {
  const kept = REPORTING_dropBlankRows_(allRows);
  const base = { label: REPORTING_tableLabel_(name, sheetName), sourceName: name, sheetName: sheetName || '', format: format };
  if (!kept.rows.length) return Object.assign(base, { headers: [], rows: [], rowNumbers: [], role: 'empty' });
  const clean = function (row) { return row.map(function (h) { return h === null || h === undefined ? '' : h; }); };
  let at = 0, role = REPORTING_classifyHeaders_(clean(kept.rows[0]));
  for (let k = 1; role === 'none' && k < Math.min(kept.rows.length, REPORTING_CONFIG.PROBE_ROWS); k++) {
    const r = REPORTING_classifyHeaders_(clean(kept.rows[k]));
    if (r !== 'none') { at = k; role = r; }
  }
  return Object.assign(base, {
    headers: clean(kept.rows[at]),
    rows: kept.rows.slice(at + 1),
    rowNumbers: kept.rowNumbers.slice(at + 1),
    role: role
  });
}

/**
 * One added item ({ name, mimeType, base64 }): a file, or cells pasted from Excel / Google Sheets
 * (sent by the browser as a .tsv or .csv text file). Returns { sourceName, signature, tables }.
 * A text file gives one table; an Excel workbook gives one table per sheet.
 * Every failure is a specific Error the person can act on.
 */
function REPORTING_parseUploadedFile_(fileObj) {
  if (!fileObj || typeof fileObj !== 'object') throw new Error('A file was not received. Add it again and retry.');
  const name = String(fileObj.name || '').trim();
  if (!name) throw new Error('An added file has no name. Add it again and retry.');
  const base64 = fileObj.base64;
  if (!base64 || typeof base64 !== 'string') throw new Error('"' + name + '" is empty or could not be read.');

  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes > REPORTING_CONFIG.MAX_FILE_BYTES) {
    throw new Error('"' + name + '" is ' + (approxBytes / 1048576).toFixed(1) + ' MB. The limit is ' +
      (REPORTING_CONFIG.MAX_FILE_BYTES / 1048576) + ' MB per file.');
  }

  let bytes;
  try { bytes = Utilities.base64Decode(base64); }
  catch (e) { throw new Error('"' + name + '" could not be decoded. It may be damaged.'); }
  if (!bytes || bytes.length === 0) throw new Error('"' + name + '" is empty (0 bytes).');

  const ext = REPORTING_extensionOf_(name);
  let tables;
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    tables = [REPORTING_buildTable_(REPORTING_parseDelimitedText_(bytes, name, ext), name, '', 'text')];
  } else if (ext === 'xlsx' || ext === 'xls') {
    tables = REPORTING_parseXlsx_(bytes, name, ext);
  } else {
    throw new Error('"' + name + '" is a ' + (ext ? '.' + ext : 'file without an extension') +
      '. Supported: .csv, .tsv, .xlsx, or cells pasted from Excel or Google Sheets.');
  }
  if (tables.every(function (t) { return t.role === 'empty'; })) {
    throw new Error('"' + name + '" contains no data (every row is empty).');
  }
  return {
    sourceName: name,
    tables: tables,
    signature: Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes))
  };
}

/** CSV, TSV, or pasted cells. A .txt file is tab-separated when its first line has a tab. */
function REPORTING_parseDelimitedText_(bytes, name, ext) {
  let text;
  try { text = Utilities.newBlob(bytes, 'text/plain', name).getDataAsString('UTF-8'); }
  catch (e) { throw new Error('"' + name + '" is not readable text.'); }
  if (text.length && text.charCodeAt(0) === 0xFEFF) text = text.substring(1); // byte order mark
  if (text.indexOf('\u0000') !== -1) {
    throw new Error('"' + name + '" is not a UTF-8 text file (it contains binary data). If it is an Excel file, keep its .xlsx extension; if it was saved as "Unicode text", save it as "CSV UTF-8" instead.');
  }
  let delimiter = ',';
  if (ext === 'tsv') delimiter = '\t';
  else if (ext === 'txt' && text.split(/\r?\n/, 1)[0].indexOf('\t') !== -1) delimiter = '\t';
  try {
    return Utilities.parseCsv(text, delimiter);
  } catch (e) {
    throw new Error('"' + name + '" could not be read as ' + (delimiter === '\t' ? 'tab-separated text' : 'CSV') + ': ' + e.message);
  }
}

/** Per-user scratch folder for .xlsx conversion. Per user, because the app runs as each user. */
function REPORTING_getTempFolder_() {
  const props = PropertiesService.getUserProperties();
  const cachedId = props.getProperty(REPORTING_CONFIG.TEMP_FOLDER_PROP);
  if (cachedId) {
    try {
      const f = DriveApp.getFolderById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  let folder = null;
  const it = DriveApp.getFoldersByName(REPORTING_CONFIG.TEMP_FOLDER_NAME);
  while (it.hasNext()) {
    const candidate = it.next();
    if (!candidate.isTrashed()) { folder = candidate; break; }
  }
  if (!folder) folder = DriveApp.createFolder(REPORTING_CONFIG.TEMP_FOLDER_NAME);
  props.setProperty(REPORTING_CONFIG.TEMP_FOLDER_PROP, folder.getId());
  return folder;
}

/** Removes temp files left behind by a run that was cut off (for example by the 6-minute limit). */
function REPORTING_cleanStaleTempFiles_(folder) {
  try {
    const cutoff = Date.now() - REPORTING_CONFIG.STALE_TEMP_MS;
    const it = folder.getFiles();
    let n = 0;
    while (it.hasNext() && n < 20) {
      const f = it.next();
      n++;
      if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
    }
  } catch (e) {}
}

/** Converts an Excel blob to a temporary Google Sheet. Works with the Drive API advanced service v2 or v3. */
function REPORTING_convertToSheet_(blob, folderId) {
  const title = 'wfm-reporting-temp-' + Utilities.getUuid();
  if (typeof Drive.Files.insert === 'function') {               // Drive API v2
    return Drive.Files.insert({ title: title, mimeType: REPORTING_SHEET_MIME_, parents: [{ id: folderId }] },
      blob, { convert: true }).id;
  }
  if (typeof Drive.Files.create === 'function') {               // Drive API v3 (the current default)
    return Drive.Files.create({ name: title, mimeType: REPORTING_SHEET_MIME_, parents: [folderId] }, blob).id;
  }
  throw new Error('the Drive API advanced service is enabled but has an unexpected version.');
}

/**
 * Reads an .xlsx/.xls by letting Google convert it to a temporary Google Sheet (the same engine the
 * production pipeline's data lives in), reading it, and deleting it. No hand-written Excel parser.
 * Every sheet is looked at, so one workbook can hold both reports. Only the header area is read
 * first; full data is read only for sheets recognized as one of the two reports.
 * The temp sheet is switched to New York time BEFORE reading: Sheets hands back date cells as
 * instants in the spreadsheet's own time zone, and a freshly converted file gets the uploader's
 * account time zone, which would shift every time by hours.
 */
function REPORTING_parseXlsx_(bytes, name, ext) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('"' + name + '" is an Excel file. Reading Excel files needs the "Drive API" service ' +
      'turned on for this Apps Script project (editor, Services, +, Drive API). Ask an Admin, or paste the ' +
      'cells or upload a .csv instead.');
  }
  const folder = REPORTING_getTempFolder_();
  REPORTING_cleanStaleTempFiles_(folder);
  const blob = Utilities.newBlob(bytes, ext === 'xls' ? REPORTING_XLS_MIME_ : REPORTING_XLSX_MIME_, name);

  let tempId = null;
  try {
    tempId = REPORTING_convertToSheet_(blob, folder.getId());
    const ss = SpreadsheetApp.openById(tempId);
    ss.setSpreadsheetTimeZone(REPORTING_CONFIG.TIMEZONE);
    return ss.getSheets().map(function (sheet) {
      const sheetName = sheet.getName();
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (!lastRow || !lastCol) return REPORTING_buildTable_([], name, sheetName, 'xlsx');
      const probeRows = Math.min(lastRow, REPORTING_CONFIG.PROBE_ROWS);
      const probe = REPORTING_buildTable_(sheet.getRange(1, 1, probeRows, lastCol).getValues(), name, sheetName, 'xlsx');
      const needsAll = probe.role === 'voyce' || probe.role === 'shortCalls' || probe.role === 'empty';
      if (!needsAll || probeRows === lastRow) return probe;
      return REPORTING_buildTable_(sheet.getRange(1, 1, lastRow, lastCol).getValues(), name, sheetName, 'xlsx');
    });
  } catch (err) {
    throw new Error('"' + name + '" could not be read as an Excel file: ' + err.message);
  } finally {
    if (tempId) {
      try { Drive.Files.remove(tempId); }
      catch (e) { try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e2) {} }
    }
  }
}

// ============================================================================
// LAYER 3: COLUMN RESOLUTION (ported from the production script)
// ============================================================================

function REPORTING_normalizeHeader_(h) {
  return String(h === null || h === undefined ? '' : h).replace(/\s+/g, ' ').trim().toLowerCase();
}

function REPORTING_resolveColumnIndices_(headerRow, schemaDefinition, sourceLabel) {
  const colMap = {};
  const normalizedHeaders = headerRow.map(REPORTING_normalizeHeader_);
  Object.keys(schemaDefinition).forEach(function (key) {
    const aliasList = schemaDefinition[key];
    let foundIndex = -1;
    for (let a = 0; a < aliasList.length && foundIndex === -1; a++) {
      foundIndex = normalizedHeaders.indexOf(aliasList[a].toLowerCase());
    }
    if (foundIndex === -1) {
      throw new Error(sourceLabel + ' is missing the required column "' + (REPORTING_CONFIG.HEADER_LABELS[key] || key) +
        '" (accepted header names: ' + aliasList.join(', ') + ').');
    }
    colMap[key] = foundIndex;
  });
  return colMap;
}

function REPORTING_tryResolveColumnIndices_(headerRow, schemaDefinition) {
  try { return REPORTING_resolveColumnIndices_(headerRow, schemaDefinition, ''); }
  catch (e) { return null; }
}

/** Labels of the schema columns a header row does not have. */
function REPORTING_missingColumns_(headerRow, schemaDefinition) {
  const norm = headerRow.map(REPORTING_normalizeHeader_);
  return Object.keys(schemaDefinition).filter(function (key) {
    return !schemaDefinition[key].some(function (alias) { return norm.indexOf(alias.toLowerCase()) !== -1; });
  }).map(function (key) { return REPORTING_CONFIG.HEADER_LABELS[key] || key; });
}

/**
 * Which report a table is, from its header row alone (the same rule runs in the browser, from the
 * aliases getReportingCatalog sends, so what the screen shows before Process matches this):
 *   'voyce'           has every Voyce column
 *   'result'          has Accepted Codes and Short Calls: a previous Cleaned result, not a source
 *   'voyceIncomplete' has most Voyce columns but not all (reported as such, never used as Short Calls)
 *   'shortCalls'      has a Transaction Id column
 *   'none'            anything else
 */
function REPORTING_classifyHeaders_(headerRow) {
  const voyceTotal = Object.keys(REPORTING_CONFIG.VOYCE_HEADERS).length;
  const voyceHits = voyceTotal - REPORTING_missingColumns_(headerRow, REPORTING_CONFIG.VOYCE_HEADERS).length;
  if (voyceHits === voyceTotal) return 'voyce';
  const norm = headerRow.map(REPORTING_normalizeHeader_);
  if (REPORTING_CONFIG.RESULT_MARKER_HEADERS.every(function (h) { return norm.indexOf(h) !== -1; })) return 'result';
  if (voyceHits >= REPORTING_CONFIG.NEAR_VOYCE_MIN) return 'voyceIncomplete';
  if (REPORTING_tryResolveColumnIndices_(headerRow, REPORTING_CONFIG.SHORT_CALLS_HEADERS)) return 'shortCalls';
  return 'none';
}

// ============================================================================
// LAYER 4: NORMALIZATION
// ============================================================================

// ---- 4a. New York time helpers (exact, and fast: one Utilities call per hour of data, not per cell)

let REPORTING_formatOffsetCache_ = {};
let REPORTING_parseOffsetCache_ = {};

function REPORTING_pad_(n, w) { let s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

/** New York UTC offset in ms at instant t, measured with Utilities.formatDate itself. */
function REPORTING_offsetByFormat_(t) {
  const s = Utilities.formatDate(new Date(t), REPORTING_CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Math.floor(t / 1000) * 1000;
}

/**
 * Offset for the UTC hour containing t, or null when the offset changes inside that hour.
 * New York's daylight-saving changes happen on whole UTC hours, so null never occurs for it; the
 * check keeps the helper exact for any time zone anyway (null falls back to Utilities.formatDate).
 */
function REPORTING_nyOffsetMs_(t) {
  const hour = Math.floor(t / 3600000);
  let off = REPORTING_formatOffsetCache_[hour];
  if (off === undefined) {
    const start = hour * 3600000;
    const a = REPORTING_offsetByFormat_(start);
    const b = REPORTING_offsetByFormat_(start + 3599000);
    off = (a === b) ? a : null;
    REPORTING_formatOffsetCache_[hour] = off;
  }
  return off;
}

/** New York wall-clock time of a Date, as a UTC-based millisecond count (fields read with getUTC*). */
function REPORTING_nyWallMs_(date) {
  const t = date.getTime();
  const off = REPORTING_nyOffsetMs_(t);
  if (off !== null) return t + off;
  return t + REPORTING_offsetByFormat_(t); // exact slow path
}

/** Same string as Utilities.formatDate(date, 'America/New_York', 'yyyy-MM-dd HH:mm:ss'). */
function REPORTING_formatNy_(date) {
  const w = new Date(REPORTING_nyWallMs_(date));
  return w.getUTCFullYear() + '-' + REPORTING_pad_(w.getUTCMonth() + 1) + '-' + REPORTING_pad_(w.getUTCDate()) + ' ' +
    REPORTING_pad_(w.getUTCHours()) + ':' + REPORTING_pad_(w.getUTCMinutes()) + ':' + REPORTING_pad_(w.getUTCSeconds());
}

/** Excel date serial (1900 system) of the New York wall-clock time; what Excel shows equals the display string. */
function REPORTING_excelSerialNy_(date) {
  return REPORTING_nyWallMs_(date) / 86400000 + 25569;
}

/** New York wall-clock fields -> the instant, exactly as Utilities.parseDate(..., 'America/New_York', ...) gives it. */
function REPORTING_nyLocalToDate_(y, mo, d, h, mi, s, ms) {
  const key = y + '-' + mo + '-' + d + '-' + h;
  let off = REPORTING_parseOffsetCache_[key];
  if (off === undefined) {
    const hourStart = Utilities.parseDate(
      REPORTING_pad_(y, 4) + '-' + REPORTING_pad_(mo) + '-' + REPORTING_pad_(d) + 'T' + REPORTING_pad_(h) + ':00:00',
      REPORTING_CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
    off = Date.UTC(y, mo - 1, d, h, 0, 0) - hourStart.getTime();
    REPORTING_parseOffsetCache_[key] = off;
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - off);
}

// ---- 4b. Date text recognition (CSV cells, and text cells inside an .xlsx)

const REPORTING_TIME_PART_ = '(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d{1,9}))?)?\\s*([AaPp][Mm])?)?';
const REPORTING_DATE_RE_ = {
  ymd: new RegExp('^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})' + REPORTING_TIME_PART_ + '\\s*(Z|[+-]\\d{2}:?\\d{2})?$'),
  slash: new RegExp('^(\\d{1,2})/(\\d{1,2})/(\\d{4})' + REPORTING_TIME_PART_ + '$')
};
const REPORTING_SUPPORTED_DATE_TEXT_ =
  '2026-09-25 08:26:30, 2026-09-25T08:26:30, 2026/09/25 08:26, 09/25/2026 08:26:30, 9/25/2026 8:26:30 AM, 25/09/2026 08:26 (seconds and AM/PM optional)';

/**
 * Looks at every d/m/yyyy-style date in the file to decide which number is the month.
 * A first number above 12 proves day-first; a second number above 12 proves month-first.
 * If nothing proves either, month-first (US, the format Voyce uses) is assumed and the UI says so.
 */
function REPORTING_detectSlashOrder_(values, label) {
  let dayFirst = false, monthFirst = false, any = false;
  for (let i = 0; i < values.length; i++) {
    const m = REPORTING_DATE_RE_.slash.exec(values[i]);
    if (!m) continue;
    any = true;
    if (+m[1] > 12) dayFirst = true;
    if (+m[2] > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) {
    throw new Error(label + ' mixes month/day and day/month dates (for example both 13/01/2026 and 01/13/2026). ' +
      'Export it again with one date format.');
  }
  if (!any) return { order: null, assumed: false };
  if (dayFirst) return { order: 'DMY', assumed: false };
  return { order: 'MDY', assumed: !monthFirst };
}

function REPORTING_daysInMonth_(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }

/** Text -> Date (New York wall time, or the stated offset when the text has Z/+hh:mm). null when not recognized. */
function REPORTING_parseDateText_(text, slashOrder, stats) {
  const s = String(text).trim();
  let y, mo, d, tz = null, t;
  let m = REPORTING_DATE_RE_.ymd.exec(s);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3]; t = m.slice(4, 9); tz = m[9] || null;
  } else {
    m = REPORTING_DATE_RE_.slash.exec(s);
    if (!m) return null;
    y = +m[3];
    if (slashOrder === 'DMY') { d = +m[1]; mo = +m[2]; } else { mo = +m[1]; d = +m[2]; }
    t = m.slice(4, 9);
  }
  let h = t[0] === undefined ? 0 : +t[0];
  const mi = t[1] === undefined ? 0 : +t[1];
  const sec = t[2] === undefined ? 0 : +t[2];
  const ms = t[3] === undefined ? 0 : Math.floor(Number('0.' + t[3]) * 1000);
  const ampm = t[4] ? t[4].toUpperCase() : null;

  if (mo < 1 || mo > 12 || d < 1 || d > REPORTING_daysInMonth_(y, mo)) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
  }
  if (h > 23 || mi > 59 || sec > 59) return null;
  if (stats && t[0] !== undefined && t[2] === undefined) stats.noSeconds++;

  if (tz) {
    let offMin = 0;
    if (tz !== 'Z') {
      const tm = tz.match(/^([+-])(\d{2}):?(\d{2})$/);
      offMin = (tm[1] === '-' ? -1 : 1) * (+tm[2] * 60 + +tm[3]);
    }
    return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offMin * 60000);
  }
  return REPORTING_nyLocalToDate_(y, mo, d, h, mi, sec, ms);
}

/**
 * Makes the date columns hold what a live Google Sheet would hold: real Date objects, or blank.
 * Anything else in a date column (unrecognized text, a bare number) stops the run with the row and
 * column named, instead of being quietly treated as empty and changing the result.
 * Returns { order, assumed, noSeconds } (noSeconds: time values written without seconds).
 */
function REPORTING_convertDateColumns_(table, columns) {
  const texts = [];
  table.rows.forEach(function (row) {
    columns.forEach(function (c) { const v = row[c.index]; if (typeof v === 'string' && v.trim()) texts.push(v.trim()); });
  });
  const slash = REPORTING_detectSlashOrder_(texts, table.label);
  const stats = { noSeconds: 0 };

  table.rows.forEach(function (row, i) {
    columns.forEach(function (c) {
      const v = row[c.index];
      if (REPORTING_isBlankCell_(v)) { row[c.index] = ''; return; }
      if (v instanceof Date) { if (isNaN(v.getTime())) row[c.index] = ''; return; }
      let d = null;
      if (typeof v === 'string') d = REPORTING_parseDateText_(v, slash.order, stats);
      if (!d) {
        throw new Error(table.label + ', row ' + table.rowNumbers[i] + ', column "' + c.label + '": "' + String(v) +
          '" is not a date/time this tool can read safely. Accepted formats: ' + REPORTING_SUPPORTED_DATE_TEXT_ + '.');
      }
      row[c.index] = d;
    });
  });
  return { order: slash.order, assumed: slash.assumed, noSeconds: stats.noSeconds };
}

/**
 * Text sources only (CSV, TSV, pasted cells): turns number text into the value a Google Sheet would
 * store if the same data were pasted or imported there, because the production pipeline always
 * received its data through a Sheet. "67,439,801" -> "67439801" and "67439801.0" -> "67439801".
 * Nothing else is changed.
 */
function REPORTING_sheetNumberText_(v) {
  if (typeof v !== 'string') return v;
  let s = v.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  const m = s.match(/^(-?\d+)\.0+$/);
  if (m) s = m[1];
  return s;
}

/**
 * Text sources only. ID columns: normalizes number text (above), and refuses IDs written in
 * scientific notation (for example "6.74398E+07", which Excel shows for long numbers in narrow or
 * "General" columns): the missing digits cannot be recovered, so matching would silently fail.
 */
function REPORTING_prepareIdColumns_(table, columns) {
  if (table.format !== 'text') return;
  table.rows.forEach(function (row, i) {
    columns.forEach(function (c) {
      const v = REPORTING_sheetNumberText_(row[c.index]);
      if (typeof v === 'string' && c.id && /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(v)) {
        throw new Error(table.label + ', row ' + table.rowNumbers[i] + ', column "' + c.label + '": "' + v +
          '" is in scientific notation, so digits are missing. In Excel, format that column as Number with 0 decimals ' +
          '(or as Text), then copy or export again.');
      }
      row[c.index] = v;
    });
  });
}

function REPORTING_prepareVoyceTable_(table, colMap) {
  const h = function (k) { return String(table.headers[colMap[k]]); };
  REPORTING_prepareIdColumns_(table, [
    { index: colMap.TRANSACTION_ID, label: h('TRANSACTION_ID'), id: true },
    { index: colMap.INTERPRETER_ID, label: h('INTERPRETER_ID'), id: true },
    { index: colMap.SECONDS_TO_ANSWER, label: h('SECONDS_TO_ANSWER'), id: false }
  ]);
  return REPORTING_convertDateColumns_(table, [
    { index: colMap.REQUEST_TIME, label: h('REQUEST_TIME') },
    { index: colMap.ASSIGNED_TIME, label: h('ASSIGNED_TIME') },
    { index: colMap.ACCEPTED_TIME, label: h('ACCEPTED_TIME') }
  ]);
}

function REPORTING_prepareShortCallsTable_(table, colMap) {
  REPORTING_prepareIdColumns_(table, [
    { index: colMap.TRANSACTION_ID, label: String(table.headers[colMap.TRANSACTION_ID]), id: true }
  ]);
}

// ---- 4c. Scalar helpers, verbatim from the production script

function REPORTING_parseNumericStrict_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const num = Number(trimmed);
    return isNaN(num) ? null : num;
  }
  return null;
}

function REPORTING_normalizeTransactionId_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toFixed(0) : String(value).trim();
  return String(value).trim();
}

/** After layer 4b every date cell is a Date or blank, so this is the production helper's Date branch. */
function REPORTING_parseDateTimeSafe_(val) {
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  return null;
}

// ============================================================================
// LAYER 5: BUSINESS LOGIC (production script, phases 3-7)
// ============================================================================

function REPORTING_newDiagnostics_() {
  return {
    status: 'INITIALIZING',
    voyceFileName: '', shortCallsFileName: '',
    voyceSource: '', shortCallsSource: '',   // which file (and sheet) was used for each report
    skippedSources: [],                     // other tables that were looked at and left out, with why
    dateOrderAssumed: false, dateOrder: '',
    timesWithoutSeconds: 0,
    voyceRawRowCount: 0, shortCallsRawRowCount: 0,
    rowsSkippedNoTransactionId: 0,
    rowsRemovedSecondsToAnswer: 0,
    malformedSecondsToAnswer: 0,
    duplicateGroupsDetected: 0,
    duplicateRowsRemovedEmptyH: 0,
    duplicateGroupsRemovedAllEmptyH: 0,
    duplicateGroupsMultiPopulatedH: 0,
    finalCleanedRowCount: 0,
    shortCallsDistinctIds: 0,
    shortCallsMatchedCount: 0,
    acceptedTransactionsCount: 0,
    executionTimeMs: 0
  };
}

/** Phase 3: skip rows without a Transaction Id; Rule 1 removes SecondsToAnswer <= 1. */
function REPORTING_normalizeAndFilterVoyceData_(rawRows, colMap, diagnostics) {
  const qualifiedRecords = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rawTxId = row[colMap.TRANSACTION_ID];
    if (rawTxId === null || rawTxId === undefined || String(rawTxId).trim() === '') {
      diagnostics.rowsSkippedNoTransactionId++;
      continue;
    }
    const parsedSeconds = REPORTING_parseNumericStrict_(row[colMap.SECONDS_TO_ANSWER]);
    if (parsedSeconds === null || isNaN(parsedSeconds)) {
      diagnostics.malformedSecondsToAnswer++;
      continue;
    }
    if (parsedSeconds <= 1) {
      diagnostics.rowsRemovedSecondsToAnswer++;
      continue;
    }
    const acceptedDate = REPORTING_parseDateTimeSafe_(row[colMap.ACCEPTED_TIME]);
    qualifiedRecords.push({
      interpreterId: row[colMap.INTERPRETER_ID],
      interpreterName: row[colMap.INTERPRETER_NAME],
      requestTime: REPORTING_parseDateTimeSafe_(row[colMap.REQUEST_TIME]),
      assignedTime: REPORTING_parseDateTimeSafe_(row[colMap.ASSIGNED_TIME]),
      transactionId: REPORTING_normalizeTransactionId_(rawTxId),
      hasValidAcceptedTime: acceptedDate !== null
    });
  }
  return qualifiedRecords;
}

/** Phases 4-5: group by Transaction Id + AssignedToInterpreterTime, then resolve with AcceptedByInterpreterTime. */
function REPORTING_resolveDuplicateGroups_(records, diagnostics) {
  const groupMap = new Map();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const assignedTimeKey = record.assignedTime ? REPORTING_formatNy_(record.assignedTime) : 'NO_ASSIGNED_TIME';
    const canonicalKey = record.transactionId + '|' + assignedTimeKey;
    let group = groupMap.get(canonicalKey);
    if (!group) { group = []; groupMap.set(canonicalKey, group); }
    group.push(record);
  }

  const finalCleanedRecords = [];
  groupMap.forEach(function (group) {
    if (group.length === 1) { finalCleanedRecords.push(group[0]); return; }
    diagnostics.duplicateGroupsDetected++;
    const withH = group.filter(function (r) { return r.hasValidAcceptedTime; });
    if (withH.length === 1) {
      finalCleanedRecords.push(withH[0]);
      diagnostics.duplicateRowsRemovedEmptyH += (group.length - 1);
    } else if (withH.length === 0) {
      diagnostics.duplicateGroupsRemovedAllEmptyH++;
    } else {
      // More than one row has a valid AcceptedByInterpreterTime. The production script keeps the
      // first one in file order; so does this. Counted so the UI can say so.
      diagnostics.duplicateGroupsMultiPopulatedH++;
      finalCleanedRecords.push(withH[0]);
      diagnostics.duplicateRowsRemovedEmptyH += (group.length - 1);
    }
  });
  return finalCleanedRecords;
}

/** Phase 6: set of normalized Transaction Ids from the Short Calls file. */
function REPORTING_buildShortCallsIndex_(rawRows, txColIndex) {
  const set = new Set();
  for (let i = 0; i < rawRows.length; i++) {
    const val = rawRows[i][txColIndex];
    if (val !== null && val !== undefined && String(val).trim() !== '') set.add(REPORTING_normalizeTransactionId_(val));
  }
  return set;
}

/** Phase 7: the six output values per record. */
function REPORTING_buildCleanedOutputRows_(cleanedRecords, shortCallsTxSet, diagnostics) {
  const output = [];
  for (let i = 0; i < cleanedRecords.length; i++) {
    const record = cleanedRecords[i];
    const isShortCall = shortCallsTxSet.has(record.transactionId) ? 1 : 0;
    if (isShortCall === 1) diagnostics.shortCallsMatchedCount++;
    let acceptedCodeVal = '';
    if (record.hasValidAcceptedTime) {
      acceptedCodeVal = record.transactionId;
      diagnostics.acceptedTransactionsCount++;
    }
    output.push([
      record.interpreterId !== undefined ? record.interpreterId : '',
      record.interpreterName !== undefined ? record.interpreterName : '',
      record.requestTime,
      acceptedCodeVal,
      record.transactionId,
      isShortCall
    ]);
  }
  return output;
}

// ============================================================================
// LAYER 6: RESULT GENERATION
// ============================================================================

/**
 * Wire format (compact, report-agnostic):
 *   columns: [{ header, type, numberFormat }]
 *   rows:    arrays of display values (strings/numbers; datetime columns as 'yyyy-MM-dd HH:mm:ss')
 *   serials: { <columnIndex>: [Excel date serial or null per row] } for datetime columns
 * Excel serials are computed here so the browser never does time-zone math.
 */
function REPORTING_buildResultPayload_(columnDefs, outputRows, diagnostics, sheetName) {
  const serials = {};
  columnDefs.forEach(function (c, idx) { if (c.type === 'datetime') serials[idx] = []; });
  const rows = outputRows.map(function (r) {
    const out = r.slice();
    columnDefs.forEach(function (c, idx) {
      if (c.type !== 'datetime') {
        if (out[idx] === null || out[idx] === undefined) out[idx] = '';
        return;
      }
      const d = out[idx];
      const ok = d instanceof Date && !isNaN(d.getTime());
      serials[idx].push(ok ? REPORTING_excelSerialNy_(d) : null);
      out[idx] = ok ? REPORTING_formatNy_(d) : '';
    });
    return out;
  });
  return {
    columns: columnDefs.map(function (c) { return { header: c.header, type: c.type, numberFormat: c.numberFormat || '' }; }),
    rows: rows,
    serials: serials,
    sheetName: sheetName,
    diagnostics: diagnostics
  };
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

const REPORTING_ROLE_NAME_ = { voyce: 'Voyce Performance export', shortCalls: 'Short Calls export' };

function REPORTING_joinLabels_(tables) {
  return tables.map(function (t) { return t.label; }).join(', ');
}

/**
 * Looks at every table from every added item (a CSV, pasted cells, or each sheet of a workbook) and
 * picks the Voyce Performance export and the Short Calls export. Order and file names do not matter;
 * only the columns do. Anything that is not exactly one of each is refused with the reason.
 */
function REPORTING_assignRoles_(parsedFiles) {
  for (let i = 0; i < parsedFiles.length; i++) {
    for (let j = i + 1; j < parsedFiles.length; j++) {
      if (parsedFiles[i].signature === parsedFiles[j].signature) {
        throw new Error('The same file was added twice ("' + parsedFiles[i].sourceName + '" and "' + parsedFiles[j].sourceName +
          '"). Add the Voyce Performance export and the Short Calls export.');
      }
    }
  }
  const tables = [];
  parsedFiles.forEach(function (f) { f.tables.forEach(function (t) { tables.push(t); }); });
  const byRole = function (role) { return tables.filter(function (t) { return t.role === role; }); };
  const voyce = byRole('voyce'), shortCalls = byRole('shortCalls'), incomplete = byRole('voyceIncomplete');
  const unknown = byRole('none');

  if (voyce.length > 1) {
    throw new Error('More than one Voyce Performance export was found: ' + REPORTING_joinLabels_(voyce) + '. Keep only the one you want to report on.');
  }
  if (!voyce.length && incomplete.length) {
    const t = incomplete[0];
    throw new Error(t.label + ' looks like the Voyce Performance export but is missing: ' +
      REPORTING_missingColumns_(t.headers, REPORTING_CONFIG.VOYCE_HEADERS).join(', ') + '. Export it again with all columns.');
  }
  if (shortCalls.length > 1) {
    throw new Error('More than one table could be the Short Calls export: ' + REPORTING_joinLabels_(shortCalls) + '. Keep only the one you want.');
  }
  if (!voyce.length || !shortCalls.length) {
    const parts = [];
    if (!voyce.length) parts.push('No Voyce Performance export was found.');
    if (!shortCalls.length) parts.push('No Short Calls export was found (it needs a Transaction Id column).');
    if (unknown.length) {
      parts.push('Not recognized: ' + unknown.slice(0, 3).map(function (t) {
        const cols = t.headers.map(String).filter(function (h) { return h.trim(); }).slice(0, 6);
        return t.label + (cols.length ? ' (columns: ' + cols.join(', ') + (t.headers.length > 6 ? ', ...' : '') + ')' : '');
      }).join('; ') + '.');
    }
    parts.push('Add both reports: drop or paste them together, or use one workbook that has both.');
    throw new Error(parts.join(' '));
  }

  const skipped = tables.filter(function (t) {
    return t !== voyce[0] && t !== shortCalls[0] && t.role !== 'empty';
  }).map(function (t) {
    if (t.role === 'result') return t.label + ' was skipped: it is a previous Cleaned result, not a source report.';
    if (t.role === 'voyceIncomplete') return t.label + ' was skipped: it looks like an incomplete Voyce export.';
    return t.label + ' was skipped: it is not one of the two reports.';
  });
  return { voyce: voyce[0], shortCalls: shortCalls[0], skipped: skipped };
}

/**
 * Runs the Voyce Performance Clean Report.
 * files: an array of 1 to 3 items ({ name, mimeType, base64 }) in any order: the two exports, cells
 * pasted from Excel / Google Sheets (sent as .tsv/.csv text), or one workbook holding both.
 * (The older call style runVoycePerformanceReport(fileA, fileB) is still accepted.)
 * Nothing is read from or written to any sheet of the app.
 */
function runVoycePerformanceReport(files, legacySecondFile) {
  requireRegistered_();
  const started = Date.now();
  REPORTING_formatOffsetCache_ = {};
  REPORTING_parseOffsetCache_ = {};

  const items = (Array.isArray(files) ? files : [files, legacySecondFile])
    .filter(function (f) { return f !== null && f !== undefined; });
  if (!items.length) throw new Error('Add the Voyce Performance export and the Short Calls export first.');
  if (items.length > REPORTING_CONFIG.MAX_FILES) {
    throw new Error('Add at most ' + REPORTING_CONFIG.MAX_FILES + ' files at a time: the Voyce Performance export and the Short Calls export (or one workbook that has both).');
  }
  const totalBytes = items.reduce(function (n, f) { return n + Math.floor(String((f && f.base64) || '').length * 0.75); }, 0);
  if (totalBytes > REPORTING_CONFIG.MAX_TOTAL_BYTES) {
    throw new Error('The files add up to ' + (totalBytes / 1048576).toFixed(1) + ' MB. The limit is ' +
      (REPORTING_CONFIG.MAX_TOTAL_BYTES / 1048576) + ' MB per run. Use a shorter date range.');
  }

  const parsed = items.map(function (f) { return REPORTING_parseUploadedFile_(f); });
  const roles = REPORTING_assignRoles_(parsed);
  const voyce = roles.voyce, shortCalls = roles.shortCalls;
  const voyceCols = REPORTING_resolveColumnIndices_(voyce.headers, REPORTING_CONFIG.VOYCE_HEADERS, voyce.label);
  const shortCols = REPORTING_resolveColumnIndices_(shortCalls.headers, REPORTING_CONFIG.SHORT_CALLS_HEADERS, shortCalls.label);

  const diagnostics = REPORTING_newDiagnostics_();
  diagnostics.voyceFileName = voyce.sourceName;
  diagnostics.shortCallsFileName = shortCalls.sourceName;
  diagnostics.voyceSource = voyce.label;
  diagnostics.shortCallsSource = shortCalls.label;
  diagnostics.skippedSources = roles.skipped;
  diagnostics.voyceRawRowCount = voyce.rows.length;
  diagnostics.shortCallsRawRowCount = shortCalls.rows.length;

  const dates = REPORTING_prepareVoyceTable_(voyce, voyceCols);
  diagnostics.dateOrder = dates.order || '';
  diagnostics.dateOrderAssumed = dates.assumed;
  diagnostics.timesWithoutSeconds = dates.noSeconds;
  REPORTING_prepareShortCallsTable_(shortCalls, shortCols);

  let outputRows = [];
  if (voyce.rows.length === 0) {
    diagnostics.status = 'COMPLETED_EMPTY_SOURCE';
  } else {
    const qualified = REPORTING_normalizeAndFilterVoyceData_(voyce.rows, voyceCols, diagnostics);
    const deduplicated = REPORTING_resolveDuplicateGroups_(qualified, diagnostics);
    const shortSet = REPORTING_buildShortCallsIndex_(shortCalls.rows, shortCols.TRANSACTION_ID);
    diagnostics.shortCallsDistinctIds = shortSet.size;
    outputRows = REPORTING_buildCleanedOutputRows_(deduplicated, shortSet, diagnostics);
    diagnostics.status = 'SUCCESS';
  }
  diagnostics.finalCleanedRowCount = outputRows.length;

  const payload = REPORTING_buildResultPayload_(REPORTING_CONFIG.VOYCE_OUTPUT_COLUMNS, outputRows, diagnostics,
    REPORTING_CONFIG.VOYCE_SHEET_NAME);
  diagnostics.executionTimeMs = Date.now() - started;
  return payload;
}