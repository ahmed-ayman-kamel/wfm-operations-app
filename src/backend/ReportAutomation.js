/**
 * ReportAutomation.gs
 * -----------------------------------------------------------------------
 * Automated fetching for the WFM App's Reporting section.
 * Replaces manual Excel upload for three source reports:
 *   1. Voyce  - "Provider Online Time Detail Report" (ReportId 12)   -> standalone report
 *   2. Voyce  - "Provider Time To Answer Report Detail" (ReportId 37) -> feeds the Voyce Performance Report
 *   3. Sisense - "Voyce Short calls" dashboard, "Short calls by
 *      vendors/agents and <2" widget                                 -> feeds the cleaned Short Calls report
 *
 * SETUP REQUIRED before running anything here:
 *   Project Settings > Script Properties, add:
 *     VOYCE_USERNAME, VOYCE_PASSWORD, SISENSE_USERNAME, SISENSE_PASSWORD
 *
 * IMPORTANT - single-session accounts:
 *   The Voyce account enforces one concurrent session. If the credentials
 *   above belong to a personal login, running this while that person is
 *   also logged in interactively will log them out (and vice versa).
 *   Prefer a dedicated automation-only Voyce account if one can be
 *   requested; otherwise expect occasional collisions and retry.
 *
 * STATUS:
 *   - Voyce fetch (both reports): protocol copied from the site's own JS
 *     and verified live end to end (run -> poll -> CSV download) for
 *     ReportId 12 and 37. Report 37's headers match Reporting.gs.
 *   - Sisense fetch: query built from the widget's live definition
 *     (table, columns, dashboard filters and the hidden ServiceMinutes<2
 *     widget filter). Run TEST_fetchSisenseShortCalls to confirm.
 * -----------------------------------------------------------------------
 */

// ============================= CONFIG ===================================

var VOYCE_BASE = 'https://www.voyceglobal.com';
var VOYCE_COMPANY = 'YOUR_COMPANY_CODE';
var SISENSE_BASE = 'https://your-tenant.sisense.com';
var SISENSE_DATASOURCE = 'VOYCE Today';
var SISENSE_DASHBOARD_OID = 'YOUR_SISENSE_DASHBOARD_OID';

var VOYCE_REPORT_IDS = {
  ONLINE_TIME_DETAIL: 12,   // "Provider Online Time Detail Report" (standalone)
  TIME_TO_ANSWER_DETAIL: 37 // "Provider Time To Answer Report Detail" (feeds Voyce Performance Report)
};

function props_() {
  return PropertiesService.getScriptProperties();
}

// ============================= VOYCE =====================================
//
// Protocol verified live against voyceglobal.com (26 Sep 2026), copied
// from the site's own Report/js/Ajax_GeneralReport.js:
//
//   1. Login: POST Login.aspx?Company=YOUR_COMPANY_CODE with the ASP.NET hidden
//      fields + txtLoginName + txtPwd  ->  302 to InitialAction.aspx?
//      LoginSessionId=..&LoginProcessorId=..&VoyceToken=..
//   2. Run:   POST Report/AjaxRpt_StandardRun.aspx, form body carries the
//      tokens + ReportType=Csv + ReportId + Rpt_Parameter{i}/Name{i}
//      -> plain-text async job id (e.g. "3792200")
//   3. Poll:  GET Report/AjaxRpt_StandardRunResultGet.aspx?...&
//      Rpt_txtWEYIWebRequestAsyncId=<id>&<same params>
//      -> "Pending" | "Fail" | HTML containing <a href="../Report/X.csv">
//   4. Download: GET /manager/Report/X.csv

var VOYCE_MAIN = VOYCE_BASE + '/manager/Main/';

/**
 * Parameter layout of each report's run form, read from the live
 * AjaxRpt_Standard.aspx form. Order matters (Rpt_Parameter0..N).
 * NOTE: report 12 uses Start_Time/End_Time + Interpreter, report 37
 * uses Start_Date/End_Date and has no Interpreter field.
 */
var VOYCE_REPORT_PARAMS = {
  12: ['Time_Zone', 'Interpreter', 'Start_Time', 'End_Time', 'Help'],
  37: ['Time_Zone', 'Start_Date', 'End_Date', 'Help']
};

/**
 * Logs into Voyce. Returns { cookies, tokens }.
 * Redirects are followed manually so that cookies set on every hop
 * (Login -> InitialAction -> ...) are kept.
 */
function voyceLogin_() {
  var username = props_().getProperty('VOYCE_USERNAME');
  var password = props_().getProperty('VOYCE_PASSWORD');
  if (!username || !password) {
    throw new Error('VOYCE_USERNAME / VOYCE_PASSWORD not set in Script Properties.');
  }

  var loginPageUrl = VOYCE_MAIN + 'Login.aspx?Company=' + VOYCE_COMPANY;
  var pageResp = UrlFetchApp.fetch(loginPageUrl, { muteHttpExceptions: true, followRedirects: false });
  var cookies = extractCookies_(pageResp);

  var payload = extractHiddenFields_(pageResp.getContentText());
  payload.txtLoginName = username;
  payload.txtPwd = password;

  var loginResp = UrlFetchApp.fetch(loginPageUrl, {
    method: 'post',
    payload: payload,
    headers: { Cookie: cookies },
    followRedirects: false,
    muteHttpExceptions: true
  });
  cookies = mergeCookies_(cookies, extractCookies_(loginResp));

  var location = headerValue_(loginResp, 'Location');
  if (!location || location.indexOf('LoginSessionId=') === -1) {
    Logger.log('Voyce login response (first 1500 chars): %s', loginResp.getContentText().substring(0, 1500));
    throw new Error('Voyce login failed (no session redirect). Check VOYCE_USERNAME / VOYCE_PASSWORD in Script Properties.');
  }
  var tokens = parseVoyceTokens_(location);

  // Follow the redirect chain by hand, collecting cookies on each hop.
  var url = absoluteVoyceUrl_(location, VOYCE_MAIN);
  for (var hop = 0; hop < 6 && url; hop++) {
    var r = UrlFetchApp.fetch(url, { headers: { Cookie: cookies }, followRedirects: false, muteHttpExceptions: true });
    cookies = mergeCookies_(cookies, extractCookies_(r));
    var next = headerValue_(r, 'Location');
    url = next ? absoluteVoyceUrl_(next, url) : null;
  }

  return { cookies: cookies, tokens: tokens };
}

function headerValue_(resp, name) {
  var h = resp.getAllHeaders();
  var v = h[name] || h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Resolves a (possibly relative) Voyce URL against a base URL. */
function absoluteVoyceUrl_(href, baseUrl) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.charAt(0) === '/') return VOYCE_BASE + href;
  var base = baseUrl.split('?')[0];
  base = base.substring(0, base.lastIndexOf('/') + 1);
  var parts = (base.replace(VOYCE_BASE, '') + href).split('/');
  var out = [];
  parts.forEach(function (p) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  });
  return VOYCE_BASE + out.join('/');
}

function parseVoyceTokens_(url) {
  var q = url.substring(url.indexOf('?') + 1);
  var params = {};
  q.split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    params[decodeURIComponent(pair.substring(0, i))] = decodeURIComponent(pair.substring(i + 1));
  });
  if (!params.LoginSessionId || !params.LoginProcessorId || !params.VoyceToken) {
    throw new Error('Voyce login redirect is missing session tokens: ' + url);
  }
  return {
    LoginSessionId: params.LoginSessionId,
    LoginProcessorId: params.LoginProcessorId,
    VoyceToken: params.VoyceToken
  };
}

function voyceTokenQuery_(tokens) {
  return 'LoginSessionId=' + encodeURIComponent(tokens.LoginSessionId) +
    '&LoginProcessorId=' + encodeURIComponent(tokens.LoginProcessorId) +
    '&VoyceToken=' + encodeURIComponent(tokens.VoyceToken);
}

/** Pulls every <input type="hidden" name="..." value="..."> pair out of a page's HTML. */
function extractHiddenFields_(html) {
  var fields = {};
  var re = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  var match;
  while ((match = re.exec(html)) !== null) {
    var tag = match[0];
    var nameMatch = tag.match(/name=["']([^"']+)["']/i);
    if (!nameMatch) continue;
    var valueMatch = tag.match(/value=["']([^"']*)["']/i);
    fields[nameMatch[1]] = valueMatch ? htmlDecode_(valueMatch[1]) : '';
  }
  return fields;
}

function htmlDecode_(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Accepts a Date, "yyyy-MM-dd" (what the page's date pickers send) or "M/d/yy"; returns "M/d/yy" (the format the Voyce form uses). */
function voyceDate_(d) {
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, 'America/New_York', 'M/d/yy');
  }
  var s = String(d).trim();
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return Number(iso[2]) + '/' + Number(iso[3]) + '/' + iso[1].slice(2);
  return s;
}

/**
 * Runs a Voyce standard report end-to-end and returns the CSV text.
 * @param {Object} session   from voyceLogin_()
 * @param {number} reportId  12 or 37
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @param {Object} [opts]    { timeZoneId: 15 (Eastern), interpreterId: 0 (All) }
 */
function voyceRunReport_(session, reportId, startDate, endDate, opts) {
  opts = opts || {};
  var names = VOYCE_REPORT_PARAMS[reportId];
  if (!names) throw new Error('No parameter layout defined for Voyce ReportId ' + reportId);

  var values = {
    Time_Zone: opts.timeZoneId != null ? opts.timeZoneId : 15,
    Interpreter: opts.interpreterId != null ? opts.interpreterId : 0,
    Start_Time: voyceDate_(startDate), Start_Date: voyceDate_(startDate),
    End_Time: voyceDate_(endDate), End_Date: voyceDate_(endDate),
    Help: ''
  };

  // Same string GetPara() builds in the site's own JS.
  var para = 'ReportId=' + reportId + '&Rpt_txtParameterCount=' + names.length;
  names.forEach(function (name, i) {
    para += '&Rpt_Parameter' + i + '=' + encodeURIComponent(String(values[name]));
    para += '&Rpt_ParameterName' + i + '=' + encodeURIComponent(name);
  });

  var tokenQuery = voyceTokenQuery_(session.tokens);
  var ajaxHeaders = {
    Cookie: session.cookies,
    'X-Requested-With': 'XMLHttpRequest',
    'If-Modified-Since': 'Sat, 1 Jan 2000 00:00:00 GMT'
  };

  // 1) Start the async run (everything in the form body, like the site does).
  var runBody = 'v=' + Date.now() + '&' + tokenQuery + '&CallType=Ajax&ReportType=Csv&' + para +
    '&pUIComponentName=' + encodeURIComponent('Run Reqport') +
    '&pUIComponentType=Button&pUIComponentTriggerType=Click' +
    '&pUIComponentLocatedPath=' + encodeURIComponent('Report:Run');
  var runResp = UrlFetchApp.fetch(VOYCE_MAIN + 'Report/AjaxRpt_StandardRun.aspx', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    payload: runBody,
    headers: ajaxHeaders,
    muteHttpExceptions: true
  });
  var asyncId = runResp.getContentText().trim();
  if (runResp.getResponseCode() !== 200 || !/^\d+$/.test(asyncId)) {
    var cookieNames = (session.cookies || '').split(';').map(function (c) { return c.split('=')[0].trim(); }).join(', ');
    throw new Error('Voyce report ' + reportId + ' did not start (HTTP ' + runResp.getResponseCode() + '): ' +
      asyncId.substring(0, 300) + ' | session cookies held: [' + cookieNames + ']');
  }

  // 2) Poll every 2s, up to ~2 minutes.
  var pollBase = VOYCE_MAIN + 'Report/AjaxRpt_StandardRunResultGet.aspx?' + tokenQuery +
    '&CallType=Ajax&Rpt_txtWEYIWebRequestAsyncId=' + encodeURIComponent(asyncId) + '&' + para;
  var result = 'Pending';
  for (var i = 0; i < 60 && result === 'Pending'; i++) {
    Utilities.sleep(2000);
    var pollResp = UrlFetchApp.fetch(pollBase + '&v=' + Date.now(), { headers: ajaxHeaders, muteHttpExceptions: true });
    result = pollResp.getContentText().trim();
  }
  if (result === 'Pending') throw new Error('Voyce report ' + reportId + ' still pending after 2 minutes.');
  if (result === 'Fail' || result === '') throw new Error('Voyce report ' + reportId + ' failed on the Voyce side: "' + result + '"');

  var hrefMatch = result.match(/href=["']([^"']+\.csv)["']/i);
  if (!hrefMatch) {
    throw new Error('Voyce report ' + reportId + ' finished but no CSV link was found: ' + result.substring(0, 300));
  }

  // 3) Download. The link is relative to /manager/Main/Report.aspx -> /manager/Report/<file>.csv
  var fileUrl = encodeURI(absoluteVoyceUrl_(htmlDecode_(hrefMatch[1]), VOYCE_MAIN + 'Report.aspx'));
  // Voyce reports "done" slightly before the file is actually servable
  // (verified: the same URL 404'd for the script, then returned 200
  // shortly after), so retry for up to ~60s before giving up.
  var fileResp = null;
  for (var attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) Utilities.sleep(3000);
    fileResp = UrlFetchApp.fetch(fileUrl, { headers: { Cookie: session.cookies }, muteHttpExceptions: true });
    if (fileResp.getResponseCode() === 200) break;
  }
  if (fileResp.getResponseCode() !== 200) {
    throw new Error('Voyce CSV download failed after retries (HTTP ' + fileResp.getResponseCode() + '): ' + fileUrl);
  }
  return fileResp.getContentText('UTF-8');
}

/** Internal: "Provider Online Time Detail Report" (ReportId 12). Private (trailing _) so a web page cannot call it; callers must be guarded. */
function fetchVoyceOnlineTimeDetailReport_(startDate, endDate, opts) {
  var session = voyceLogin_();
  var csv = voyceRunReport_(session, VOYCE_REPORT_IDS.ONLINE_TIME_DETAIL, startDate, endDate, opts);
  return csvToRows_(csv, opts);
}

/** Internal: "Provider Time To Answer Report Detail" (ReportId 37). Private (trailing _) so a web page cannot call it; callers must be guarded. */
function fetchVoyceTimeToAnswerReport_(startDate, endDate, opts) {
  var session = voyceLogin_();
  var csv = voyceRunReport_(session, VOYCE_REPORT_IDS.TIME_TO_ANSWER_DETAIL, startDate, endDate, opts);
  return csvToRows_(csv, opts);
}

// ============================ SISENSE =====================================
//
// Query copied from the live definition of the "Short calls by
// vendors/agents and <2" widget (oid YOUR_SISENSE_WIDGET_OID) on the
// "Voyce Short calls" dashboard, read via /api/v1/dashboards/<oid>/widgets:
//   table:   serviceitemmaster  (elasticube "VOYCE Today")
//   rows:    InterpreterCompanyName, InterpreterFullName, Status, TransactionId
//   value:   count(TransactionId)  "# of unique Transaction Id"
//   widget filter:    ServiceMinutes < 2
//   dashboard filters: Call Status = Serviced,
//                      Language Operator/Non Operator = AOL + Spanish,
//                      Vendor/Agent, Client, Product = all (no filter needed)
//   date:    Req_Time_EST, day level, from..to inclusive

var SISENSE_TABLE = 'serviceitemmaster';

function sisenseLogin_() {
  var username = props_().getProperty('SISENSE_USERNAME');
  var password = props_().getProperty('SISENSE_PASSWORD');
  if (!username || !password) {
    throw new Error('SISENSE_USERNAME / SISENSE_PASSWORD not set in Script Properties.');
  }
  var resp = UrlFetchApp.fetch(SISENSE_BASE + '/api/v1/authentication/login', {
    method: 'post',
    payload: { username: username, password: password },
    muteHttpExceptions: true
  });
  var body = safeJsonParse_(resp.getContentText());
  var token = body && (body.access_token || body.token);
  if (resp.getResponseCode() !== 200 || !token) {
    throw new Error('Sisense login failed (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 300));
  }
  return { token: token };
}

function sisenseAuthHeaders_(session) {
  return { Authorization: 'Bearer ' + session.token };
}

/** Accepts a Date, "yyyy-MM-dd", or "M/d/yy" / "M/d/yyyy"; returns "yyyy-MM-dd". */
function sisenseDate_(d) {
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd');
  }
  var s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) throw new Error('Unrecognised date for Sisense: ' + s);
  var y = m[3].length === 2 ? '20' + m[3] : m[3];
  return y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

/** JAQL for the Short Calls widget. fromDate/toDate inclusive, any format sisenseDate_ accepts. */
function sisenseShortCallsJaql_(fromDate, toDate) {
  var T = SISENSE_TABLE;
  function col(name, extra) {
    var j = { table: T, column: name, dim: '[' + T + '.' + name + ']', datatype: 'text', title: name };
    Object.keys(extra || {}).forEach(function (k) { j[k] = extra[k]; });
    return { jaql: j };
  }
  function scope(item) { item.panel = 'scope'; return item; }

  return {
    datasource: {
      title: SISENSE_DATASOURCE, fullname: 'localhost/' + SISENSE_DATASOURCE,
      id: 'localhost_aVOYCEIAAaToday', address: 'LocalHost', database: 'aVOYCEIAAaToday', live: false
    },
    metadata: [
      col('InterpreterCompanyName'),
      col('InterpreterFullName'),
      col('Status'),
      col('TransactionId'),
      { jaql: {
        type: 'measure', formula: 'count([T1])', title: '# of unique Transaction Id',
        context: { '[T1]': { table: T, column: 'TransactionId', dim: '[' + T + '.TransactionId]', datatype: 'text' } }
      } },
      scope(col('Req_Time_EST', {
        dim: '[' + T + '.Req_Time_EST (Calendar)]', datatype: 'datetime', level: 'days',
        filter: { from: sisenseDate_(fromDate), to: sisenseDate_(toDate) }
      })),
      scope(col('Status', { filter: { members: ['Serviced'] } })),
      scope(col('Language_Op_Category', { filter: { members: ['AOL', 'Spanish'] } })),
      scope(col('ServiceMinutes', { datatype: 'numeric', filter: { toNotEqual: 2 } }))
    ]
  };
}

/**
 * Runs the Short Calls query and returns it as CSV text (header row
 * first). Uses the JSON /jaql endpoint and builds the CSV here, which
 * avoids differences between Sisense versions in the /jaql/csv export.
 */
function sisenseFetchShortCallsCsv_(fromDate, toDate) {
  var session = sisenseLogin_();
  var resp = UrlFetchApp.fetch(
    SISENSE_BASE + '/api/datasources/' + encodeURIComponent(SISENSE_DATASOURCE) + '/jaql',
    {
      method: 'post',
      contentType: 'application/json',
      headers: sisenseAuthHeaders_(session),
      payload: JSON.stringify(sisenseShortCallsJaql_(fromDate, toDate)),
      muteHttpExceptions: true
    }
  );
  var body = safeJsonParse_(resp.getContentText());
  if (resp.getResponseCode() !== 200 || !body || body.error) {
    throw new Error('Sisense query failed (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 500));
  }

  var headers = body.headers || ['InterpreterCompanyName', 'InterpreterFullName', 'Status', 'TransactionId', '# of unique Transaction Id'];
  var lines = [headers.map(csvCell_).join(',')];
  (body.values || []).forEach(function (row) {
    lines.push(row.map(function (cell) {
      var v = (cell && typeof cell === 'object') ? (cell.text != null ? cell.text : cell.data) : cell;
      return csvCell_(v);
    }).join(','));
  });
  return lines.join('\r\n');
}

function csvCell_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Public: Short Calls table as rows (see csvToRows_ for opts.stripHeader). */
function sisenseFetchShortCalls_(fromDate, toDate, opts) {
  return csvToRows_(sisenseFetchShortCallsCsv_(fromDate, toDate), opts);
}

// ============================= SHARED =====================================

/**
 * Parses CSV text into an array of row arrays.
 * @param {string} csvText
 * @param {Object} [opts]  { stripHeader: true } to drop the header row
 *                         and return only data rows.
 */
function csvToRows_(csvText, opts) {
  opts = opts || {};
  var clean = String(csvText || '').replace(/^\uFEFF/, '').replace(/\r(?!\n)/g, '');
  if (!clean.trim()) return [];
  var rows = Utilities.parseCsv(clean);
  if (opts.stripHeader && rows.length > 0) {
    return rows.slice(1);
  }
  return rows;
}

function extractCookies_(response) {
  var headers = response.getAllHeaders();
  var raw = headers['Set-Cookie'] || headers['set-cookie'];
  if (!raw) return '';
  var list = Array.isArray(raw) ? raw : [raw];
  return list.map(function (c) { return c.split(';')[0]; }).join('; ');
}

function mergeCookies_(existing, incoming) {
  var map = {};
  (existing || '').split(';').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var eq = part.indexOf('=');
    map[part.substring(0, eq)] = part.substring(eq + 1);
  });
  (incoming || '').split(';').forEach(function (part) {
    part = part.trim();
    if (!part) return;
    var eq = part.indexOf('=');
    map[part.substring(0, eq)] = part.substring(eq + 1);
  });
  return Object.keys(map).map(function (k) { return k + '=' + map[k]; }).join('; ');
}

function safeJsonParse_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// ============================ TEST HELPERS =================================

/** Run manually from the Apps Script editor to sanity-check each source in isolation. */
function TEST_fetchVoyceOnlineTimeDetail() {
  requireSetupAccess_();
  var rows = fetchVoyceOnlineTimeDetailReport_('9/25/26', '9/25/26', { stripHeader: false });
  Logger.log('Rows: %s', rows.length);
  Logger.log(JSON.stringify(rows.slice(0, 3)));
}

function TEST_fetchVoyceTimeToAnswer() {
  requireSetupAccess_();
  var rows = fetchVoyceTimeToAnswerReport_('9/25/26', '9/25/26', { stripHeader: false });
  Logger.log('Rows: %s', rows.length);
  Logger.log(JSON.stringify(rows.slice(0, 3)));
}

function TEST_fetchSisenseShortCalls() {
  requireSetupAccess_();
  var rows = sisenseFetchShortCalls_('9/25/26', '9/25/26', { stripHeader: false });
  Logger.log('Rows: %s', rows.length);
  Logger.log(JSON.stringify(rows.slice(0, 3)));
}