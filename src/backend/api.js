/**
 * Api.gs — BACKEND entry point (this project, inside the WFM App sheet).
 *
 * Deployment "WFM backend": Web app, Execute as: Me, Who has access: Anyone.
 * ("Anyone" is safe: every request must carry a Google-signed identity token, checked below.)
 *
 * Flow
 *   Browser (page served by the "WFM App - Front" project)
 *     → POST { token, action, args } here
 *     → token verified with Google → caller's email → role from the Roles sheet
 *     → central role gate (API_FUNCS_) → the existing function runs as the owner, but every
 *       identity check inside it sees the CALLER (currentUserEmail_ reads API_REQUEST_EMAIL_)
 *     → { ok, result } back to the browser.
 *   Email: the functions put messages in API_OUTBOX_ instead of sending them. They come back signed
 *   (HMAC, MAIL_SIGNING_KEY) and the front app sends them from the caller's own Google account.
 *
 * Adding a new server function the app calls: add its name to API_FUNCS_ below
 * (and the same name to FRONT_STUBS in the front's Bridge.gs).
 */

// Email of the verified caller for the current request ('' outside API requests).
var API_REQUEST_EMAIL_ = '';
// Messages queued by sendMailAsUser_ during an API request (null outside API requests).
var API_OUTBOX_ = null;

const API_ANY_ROLE_ = '*';
const API_NOT_OPERATIONS_ = ['Admin', 'Manager', 'RTM'];

/**
 * Every function the app's pages may call, with the roles allowed to call it.
 * The functions keep their own checks; this list is a second gate in one place.
 * Operations is read-only and does not use To-Do or Reporting (owner decision), so those are closed to it.
 */
const API_FUNCS_ = {
  // start-up and sync
  getInitialAppData: API_ANY_ROLE_,
  checkSystemSync: API_ANY_ROLE_,
  getAttachmentFileBlob: API_ANY_ROLE_,

  // To-Do / RTM Handover
  getDayBundle: API_NOT_OPERATIONS_,
  getTasksForShift: API_NOT_OPERATIONS_,
  updateTaskField: API_NOT_OPERATIONS_,
  updateTodoCommentWithFiles: API_NOT_OPERATIONS_,
  closeShift: API_NOT_OPERATIONS_,
  reopenShift: API_NOT_OPERATIONS_,
  exportRawSheetToCsv: API_NOT_OPERATIONS_,
  invalidateWfmCaches: API_NOT_OPERATIONS_,

  // Tickets (Tickets.gs enforces who may change what)
  getTickets: API_ANY_ROLE_,
  getTicketActivity: API_ANY_ROLE_,
  createTicket: API_ANY_ROLE_,
  updateTicket: API_ANY_ROLE_,
  addTicketComment: API_ANY_ROLE_,

  // Personal Assistant (Assistant.gs enforces Admin-only settings)
  getAssistantStatus: API_ANY_ROLE_,
  askAssistant: API_ANY_ROLE_,
  getAiSettings: API_ANY_ROLE_,
  saveAiSettings: API_ANY_ROLE_,
  testAiProvider: API_ANY_ROLE_,

  // Reporting
  getReportingCatalog: API_NOT_OPERATIONS_,
  runVoycePerformanceReport: API_NOT_OPERATIONS_,
  runAutomatedVoyceReports: API_NOT_OPERATIONS_,

  // Dashboards (each checks requireDashboardAccess_ / run roles itself)
  getDashboardMenu: API_ANY_ROLE_,
  getVoyceDashboardData: API_ANY_ROLE_,
  getVoyceDashboardStamp: API_ANY_ROLE_,
  loadVoyceOnlineHours: API_ANY_ROLE_,
  getAdherenceDashboardData: API_ANY_ROLE_,
  getAdherenceDashboardStamp: API_ANY_ROLE_,
  adhStartRun: API_ANY_ROLE_,
  adhSaveReport: API_ANY_ROLE_,
  adhReportRunFailure: API_ANY_ROLE_,
  getMvccDashboardData: API_ANY_ROLE_,
  getMvccDashboardStamp: API_ANY_ROLE_,
  mvccBackfillSisense: API_ANY_ROLE_,
  mvccStartPaidHours: API_ANY_ROLE_,
  mvccSavePaidHours: API_ANY_ROLE_,
  mvccReportRunFailure: API_ANY_ROLE_
};

function apiRoleAllowed_(rule, role) {
  if (rule === API_ANY_ROLE_) return !!role;
  const r = String(role || '').toLowerCase();
  return rule.some(function (x) { return x.toLowerCase() === r; });
}

function doPost(e) {
  const t0 = Date.now();
  let caller = '';
  let role = '';
  let action = '';
  let args = [];
  let out;
  API_OUTBOX_ = [];
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    caller = verifyIdentityToken_(req.token);              // throws if not genuine
    API_REQUEST_EMAIL_ = caller;
    _rolesDirectoryExecutionCache = null;
    role = getRolesDirectory_().byEmail[caller] || '';

    action = String(req.action || '');
    args = Array.isArray(req.args) ? req.args : [];
    let result;

    if (action === 'whoami') {
      result = { email: caller, role: role || null, registered: !!role };
    } else if (action === 'page') {
      result = apiBuildPage_(caller, role, args[0]);
    } else {
      if (!Object.prototype.hasOwnProperty.call(API_FUNCS_, action)) throw new Error('Unknown action.');
      if (!role) throw new Error('Unauthorized account.');
      if (!apiRoleAllowed_(API_FUNCS_[action], role)) {
        throw new Error('Unauthorized: this part of the app is not available for the ' + role + ' role.');
      }
      const fn = globalThis[action];
      if (typeof fn !== 'function') throw new Error('Unknown action.');
      result = fn.apply(null, args);
    }
    out = { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  } finally {
    API_REQUEST_EMAIL_ = '';
  }

  if (caller) apiAudit_(caller, role, action, args, out);   // never breaks the request
  if (caller && API_OUTBOX_ && API_OUTBOX_.length) out.mail = apiSignMail_(caller, API_OUTBOX_);
  API_OUTBOX_ = null;
  out.serverMs = Date.now() - t0;   // time spent inside the backend (for tuning)
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}


// ==========================================
// AUDIT LOG
// ==========================================
// Every change made through the backend is written to the "Audit Log" sheet: who, what, when, result.
// Reads are not logged (too many). Denied attempts are logged, so probing shows up.
// Actions marked 'none' log only the action name, never the arguments (they hold secrets or private text).

const API_AUDIT_SHEET_ = 'Audit Log';
const API_AUDIT_HEADERS_ = ['Timestamp', 'Email', 'Role', 'Action', 'Result', 'Details'];
const API_AUDIT_ACTIONS_ = {
  updateTaskField: 'args', updateTodoCommentWithFiles: 'args', closeShift: 'args', reopenShift: 'args',
  exportRawSheetToCsv: 'args', invalidateWfmCaches: 'none',
  createTicket: 'args', updateTicket: 'args', addTicketComment: 'args',
  saveAiSettings: 'none', testAiProvider: 'none',
  runVoycePerformanceReport: 'none', runAutomatedVoyceReports: 'none', loadVoyceOnlineHours: 'args',
  adhStartRun: 'none', adhSaveReport: 'none', mvccBackfillSisense: 'none', mvccStartPaidHours: 'none', mvccSavePaidHours: 'none'
};

function apiAuditClean_(v, depth) {
  if (typeof v === 'string') return v.length > 80 ? v.substring(0, 80) + '…' : v;
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 4) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 5).map(function (x) { return apiAuditClean_(x, depth + 1); });
    if (v.length > 5) out.push('…(' + v.length + ' items)');
    return out;
  }
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).slice(0, 15).forEach(function (k) {
      out[k] = /base64|key|token|password|secret/i.test(k) ? '[hidden]' : apiAuditClean_(v[k], depth + 1);
    });
    return out;
  }
  return String(v);
}

function apiAuditSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(API_AUDIT_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(API_AUDIT_SHEET_);
    sheet.getRange(1, 1, 1, API_AUDIT_HEADERS_.length).setValues([API_AUDIT_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), API_AUDIT_HEADERS_.length).setNumberFormat('@');   // text only: nothing can run as a formula
  }
  return sheet;
}

function apiAudit_(caller, role, action, args, out) {
  try {
    const mode = Object.prototype.hasOwnProperty.call(API_AUDIT_ACTIONS_, action) ? API_AUDIT_ACTIONS_[action] : null;
    const denied = !out.ok && /^(Unauthorized|Unknown action)/.test(String(out.error || ''));
    if (!mode && !denied) return;                         // a read, or an action nobody changes data with

    if (denied) {                                          // throttle: one line per person + action per minute
      const cache = CacheService.getScriptCache();
      const tkey = 'AUD_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, caller + '|' + action)).substring(0, 40);
      if (cache.get(tkey)) return;
      cache.put(tkey, '1', 60);
    }

    let details = '';
    if (mode === 'args' || (denied && !mode)) {
      details = (mode === 'args') ? JSON.stringify(apiAuditClean_(args, 0)) : '';
    }
    if (details.length > 600) details = details.substring(0, 600) + '…';
    const result = out.ok ? 'OK' : (denied ? 'DENIED: ' : 'FAILED: ') + String(out.error || '').substring(0, 150);

    apiAuditSheet_().appendRow([
      new Date().toISOString(), caller, role || '(not registered)', String(action).substring(0, 60), result, details
    ]);
  } catch (err) {
    Logger.log('Audit log failed: ' + err);
  }
}

/** The app page for the front project (same page doGet serves), plus the start-up data in one trip. */
function apiBuildPage_(email, role, params) {
  if (!role) return { registered: false, email: email };
  const p = (params && typeof params === 'object') ? params : {};
  const clean = {};
  ['page', 'ticketKey', 'date', 'shift', 'task'].forEach(function (k) {
    if (p[k] !== undefined && p[k] !== null) clean[k] = String(p[k]).substring(0, 200);
  });
  const html = buildAppTemplate_(clean).evaluate().getContent();
  let initialData = null;
  try { initialData = getInitialAppData(); } catch (e) { initialData = null; }  // the page asks again if this failed
  return { registered: true, email: email, html: html, initialData: initialData };
}

/**
 * Signs the queued messages so the front app sends exactly these, only for this caller, only once.
 * Returns { payload, sig } or { error } when the key is missing.
 */
function apiSignMail_(from, jobs) {
  const key = PropertiesService.getScriptProperties().getProperty('MAIL_SIGNING_KEY');
  if (!key) return { error: 'Email is not set up on the backend (MAIL_SIGNING_KEY missing). Your change was saved.' };
  const payload = JSON.stringify({
    from: from,
    exp: Date.now() + 15 * 60 * 1000,
    nonce: Utilities.getUuid(),
    jobs: jobs
  });
  const sig = Utilities.base64Encode(Utilities.computeHmacSha256Signature(payload, key));
  return { payload: payload, sig: sig };
}

/**
 * Checks the Google-signed identity token sent by the front app and returns the caller's email.
 * Rejects: forged/expired tokens, tokens issued to any app other than our front app, unverified emails.
 * A verified token is cached until it expires (at most 1 hour), so Google is asked once per token.
 */
function verifyIdentityToken_(token) {
  token = String(token || '');
  if (token.length > 4096 || token.split('.').length !== 3) throw new Error('Missing identity.');

  const cache = CacheService.getScriptCache();
  const key = 'IDT_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', {
    method: 'post', payload: { id_token: token }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Identity could not be verified.');
  const info = JSON.parse(res.getContentText());

  const allowed = String(PropertiesService.getScriptProperties().getProperty('API_ALLOWED_AUD') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(String);
  if (!allowed.length) throw new Error('Backend not configured: set the API_ALLOWED_AUD script property.');
  if (allowed.indexOf(info.aud) === -1) throw new Error('Identity rejected (issued to another app).');
  if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com') {
    throw new Error('Identity rejected (issuer).');
  }
  if (String(info.email_verified) !== 'true' || !info.email) throw new Error('Identity rejected (email).');

  const secondsLeft = Number(info.exp) - Math.floor(Date.now() / 1000);
  if (!(secondsLeft > 0)) throw new Error('Identity expired. Reload the app.');

  const email = String(info.email).toLowerCase().trim();
  cache.put(key, email, Math.max(1, Math.min(3600, secondsLeft)));
  return email;
}

/**
 * Guard for doGet: true only when the page runs as the person viewing it.
 * Stops the backend deployment ("Execute as: Me") from ever serving the app page as the owner.
 */
function isSameUserExecution_() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!active && active === effective;
}

/**
 * ONE-TIME SETUP (owner only, run from the editor): creates the shared key used to sign emails
 * and prints it. Copy the printed value into the FRONT project: Project Settings → Script properties
 * → MAIL_SIGNING_KEY. Running it again prints the existing key (it does not change it).
 */
function apiSetupMailKey() {
  if (!isSpreadsheetOwner_()) throw new Error('Only the spreadsheet owner can run this.');
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('MAIL_SIGNING_KEY');
  if (!key) {
    key = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now()));
    props.setProperty('MAIL_SIGNING_KEY', key);
  }
  Logger.log('MAIL_SIGNING_KEY = ' + key);
  Logger.log('Paste this value into the FRONT project → Project Settings → Script properties → MAIL_SIGNING_KEY.');
}
