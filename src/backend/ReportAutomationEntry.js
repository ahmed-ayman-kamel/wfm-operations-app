/**
 * ReportAutomationEntry.gs
 * -----------------------------------------------------------------------
 * Wires the automated fetchers (ReportAutomation.gs) into the Reporting
 * section. Reporting.gs is NOT modified: the automated path hands the
 * existing runVoycePerformanceReport() the same kind of "uploaded files"
 * a manual drag-and-drop does, so classification and cleaning are
 * exactly the same code.
 *
 * Requires ReportAutomation.gs in the same project.
 *
 * MAIN ENTRY POINT (used by the Reporting page):
 *   runAutomatedVoyceReports(startDate, endDate)
 *        Both reports for the same dates in one go (one Voyce login):
 *        { performance: <cleaned Voyce Performance Report>,
 *          onlineTime:  <Provider Online Time Detail Report>, range }
 *
 * SINGLE-REPORT ENTRY POINTS (still available, e.g. for tests):
 *   1. runAutomatedOnlineTimeDetailReport(startDate, endDate, opts)
 *        "Provider Online Time Detail Report" (Voyce ReportId 12), raw,
 *        standalone, no cleaning.
 *
 *   2. runAutomatedVoyceCleanReport(startDate, endDate)
 *        Voyce "Provider Time To Answer Report Detail" (ReportId 37)
 *        + Sisense "Short calls by vendors/agents and <2"
 *        -> existing runVoycePerformanceReport([...]) -> cleaned result.
 *
 * Dates: "M/d/yy" strings (e.g. "9/26/26") or Date objects. Ranges are
 * inclusive on both ends for both Voyce and Sisense.
 *
 * RENAME (one line, in Reporting.gs):
 *   REPORTING_REGISTRY[0].title: 'Voyce Performance Clean Report' -> 'Voyce Performance Report'
 * -----------------------------------------------------------------------
 */

/** Wraps CSV text as the {name, mimeType, base64} shape REPORTING_parseUploadedFile_ expects. */
function AUTORPT_toFileItem_(name, csvText) {
  return {
    name: name,
    mimeType: 'text/csv',
    base64: Utilities.base64Encode(csvText, Utilities.Charset.UTF_8)
  };
}

function AUTORPT_dateTag_(d) {
  return sisenseDate_(d); // yyyy-MM-dd, safe for file names
}

var AUTORPT_MAX_DAYS = 31;

/** Validates a from/to pair (any format sisenseDate_ accepts). Throws a readable error. */
function AUTORPT_checkRange_(startDate, endDate) {
  if (!startDate || !endDate) throw new Error('Pick both a From and a To date.');
  var from = sisenseDate_(startDate), to = sisenseDate_(endDate);
  if (from > to) throw new Error('The From date is after the To date.');
  var days = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  if (days > AUTORPT_MAX_DAYS) {
    throw new Error('Pick at most ' + AUTORPT_MAX_DAYS + ' days at a time (you picked ' + days + ').');
  }
}

/**
 * The Voyce account allows only one session at a time, so two fetches
 * running together would log each other out. This runs them one after
 * the other; the second person waits (up to 2 minutes) instead of failing.
 *
 * R-16 fix: this uses the DOCUMENT lock, not the script lock. Every To-Do and
 * ticket save uses the script lock (15 s wait), so holding that lock for a
 * whole Voyce fetch made other people's saves fail with "busy" (now every
 * hour, because of the scheduled Voyce Online Hours load). Voyce fetches
 * still wait for each other, because they all come through here.
 * Falls back to the script lock only if no document lock exists.
 */
function AUTORPT_withLock_(fn) {
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    throw new Error('Another automatic fetch is still running. Try again in a minute.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Report 1: "Provider Online Time Detail Report" (Voyce ReportId 12), standalone.
 *
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @param {Object} [opts]
 *   rowsOnly: true  -> returns just the data rows (2-D array, no header
 *                      row), ready to append under existing headers.
 *   otherwise       -> returns { columns, rows, sheetName, diagnostics },
 *                      the same wire shape as the other Reporting results
 *                      (header in .columns, data in .rows).
 */
function runAutomatedOnlineTimeDetailReport(startDate, endDate, opts) {
  requireRegistered_();
  opts = opts || {};
  AUTORPT_checkRange_(startDate, endDate);
  var allRows = AUTORPT_withLock_(function () {
    return fetchVoyceOnlineTimeDetailReport_(startDate, endDate, { stripHeader: false });
  });
  if (opts.rowsOnly) return allRows.slice(1);
  return AUTORPT_onlineTimePayload_(allRows, startDate, endDate);
}

/** Turns the Online Time Detail CSV rows (header first) into the Reporting result shape. */
function AUTORPT_onlineTimePayload_(allRows, startDate, endDate) {
  var header = allRows.length ? allRows[0] : [];
  var dataRows = allRows.slice(1);
  return {
    // 'auto': plain numbers (minutes, seconds, ids) become real numbers in Excel, everything else stays text.
    columns: header.map(function (h) { return { header: String(h), type: 'auto', numberFormat: '' }; }),
    rows: dataRows,
    sheetName: 'Provider Online Time Detail',
    diagnostics: {
      status: dataRows.length ? 'SUCCESS' : 'COMPLETED_EMPTY_SOURCE',
      reportId: VOYCE_REPORT_IDS.ONLINE_TIME_DETAIL,
      startDate: String(startDate),
      endDate: String(endDate),
      rowCount: dataRows.length
    }
  };
}

/**
 * Report 2: automated "Voyce Performance Report" (the renamed Voyce
 * Performance Clean Report wizard). Same cleaning as a manual upload.
 *
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @param {Object} [opts]  rowsOnly: true -> returns just the cleaned data
 *                         rows (no header), otherwise the full result payload.
 */
function runAutomatedVoyceCleanReport(startDate, endDate, opts) {
  requireRegistered_();
  opts = opts || {};
  AUTORPT_checkRange_(startDate, endDate);

  // 1. Voyce "Provider Time To Answer Report Detail" -> "Voyce Performance export" role.
  var voyceCsv = AUTORPT_withLock_(function () {
    var voyceSession = voyceLogin_();
    return voyceRunReport_(voyceSession, VOYCE_REPORT_IDS.TIME_TO_ANSWER_DETAIL, startDate, endDate);
  });

  // 2. Sisense "Short calls by vendors/agents and <2" -> "Short Calls export" role.
  var sisenseCsv = sisenseFetchShortCallsCsv_(startDate, endDate);

  var tag = AUTORPT_dateTag_(startDate) + '_' + AUTORPT_dateTag_(endDate);
  var files = [
    AUTORPT_toFileItem_('Voyce_TimeToAnswer_' + tag + '.csv', voyceCsv),
    AUTORPT_toFileItem_('Sisense_ShortCalls_' + tag + '.csv', sisenseCsv)
  ];

  // 3. Existing, unmodified pipeline from Reporting.gs.
  var result = runVoycePerformanceReport(files);
  return opts.rowsOnly ? result.rows : result;
}

/**
 * BOTH reports for the same dates, in one call (what the Reporting page uses).
 * One Voyce login fetches Time To Answer (37) and Online Time Detail (12)
 * back to back; Sisense Short Calls is fetched next; then the Time To
 * Answer + Short Calls pair goes through the unchanged cleaning pipeline.
 *
 * @param {string|Date} startDate  yyyy-MM-dd (page), M/d/yy, or Date
 * @param {string|Date} endDate
 * @return {{performance: Object, onlineTime: Object, range: {from: string, to: string}}}
 */
function runAutomatedVoyceReports(startDate, endDate) {
  requireRegistered_();
  AUTORPT_checkRange_(startDate, endDate);

  var voyce = AUTORPT_withLock_(function () {
    var session = voyceLogin_();
    return {
      timeToAnswer: voyceRunReport_(session, VOYCE_REPORT_IDS.TIME_TO_ANSWER_DETAIL, startDate, endDate),
      onlineTime: voyceRunReport_(session, VOYCE_REPORT_IDS.ONLINE_TIME_DETAIL, startDate, endDate)
    };
  });
  var sisenseCsv = sisenseFetchShortCallsCsv_(startDate, endDate);

  var tag = AUTORPT_dateTag_(startDate) + '_' + AUTORPT_dateTag_(endDate);
  var performance = runVoycePerformanceReport([
    AUTORPT_toFileItem_('Voyce_TimeToAnswer_' + tag + '.csv', voyce.timeToAnswer),
    AUTORPT_toFileItem_('Sisense_ShortCalls_' + tag + '.csv', sisenseCsv)
  ]);
  var onlineTime = AUTORPT_onlineTimePayload_(csvToRows_(voyce.onlineTime), startDate, endDate);

  return {
    performance: performance,
    onlineTime: onlineTime,
    range: { from: sisenseDate_(startDate), to: sisenseDate_(endDate) }
  };
}

// ============================ TEST HELPERS =================================

function TEST_runAutomatedVoyceReports() {
  requireSetupAccess_();   // editor-only test: it logs in to Voyce
  var out = runAutomatedVoyceReports('9/26/26', '9/26/26');
  Logger.log('Range: %s', JSON.stringify(out.range));
  Logger.log('Performance: status %s, %s rows', out.performance.diagnostics.status, out.performance.rows.length);
  Logger.log('Online Time: status %s, %s rows', out.onlineTime.diagnostics.status, out.onlineTime.rows.length);
}

function TEST_runAutomatedOnlineTimeDetailReport() {
  requireSetupAccess_();   // editor-only test: it logs in to Voyce
  var payload = runAutomatedOnlineTimeDetailReport('9/26/26', '9/26/26');
  Logger.log('Diagnostics: %s', JSON.stringify(payload.diagnostics));
  Logger.log('Columns: %s', JSON.stringify(payload.columns.map(function (c) { return c.header; })));
  Logger.log('First 3 rows: %s', JSON.stringify(payload.rows.slice(0, 3)));
}

function TEST_runAutomatedVoyceCleanReport() {
  requireSetupAccess_();   // editor-only test: it logs in to Voyce
  var payload = runAutomatedVoyceCleanReport('9/26/26', '9/26/26');
  Logger.log('Diagnostics: %s', JSON.stringify(payload.diagnostics, null, 2));
  Logger.log('Row count: %s', payload.rows.length);
  Logger.log('First 3 cleaned rows: %s', JSON.stringify(payload.rows.slice(0, 3)));
}