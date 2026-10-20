/**
 * Bridge.gs — FRONT app ("WFM App - Front", standalone, Execute as: User accessing the web app).
 *
 * This project holds no app data and no app pages. It:
 *   1. proves who the visitor is (Google identity token) and asks the backend for the page;
 *   2. sends notification emails FROM THE VISITOR'S OWN ACCOUNT (only messages signed by the backend);
 *   3. keeps My To-Do private to each person (PersonalTodo.gs, this project's UserProperties).
 * The page then talks to the backend directly (ApiShim.html in the backend project).
 *
 * Script properties needed (Project Settings → Script properties):
 *   BACKEND_URL       the backend deployment URL ending in /exec
 *   MAIL_SIGNING_KEY  the value printed by apiSetupMailKey() in the backend project
 */

function backendUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('BACKEND_URL') || '';
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    throw new Error('The front app is not set up: add the BACKEND_URL script property (the backend /exec link).');
  }
  return url;
}

/** Server-to-server call to the backend (used for the page and by the slow-route stubs below). */
function callBackendRaw_(action, args) {
  const res = UrlFetchApp.fetch(backendUrl_(), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ token: ScriptApp.getIdentityToken(), action: action, args: args || [] }),
    muteHttpExceptions: true,
    followRedirects: true
  });
  try {
    return JSON.parse(res.getContentText());
  } catch (e) {
    throw new Error('The backend did not answer correctly (HTTP ' + res.getResponseCode() + ').');
  }
}

function callBackend_(action, args) {
  const body = callBackendRaw_(action, args);
  if (body.mail) {
    try {
      if (body.mail.error) Logger.log(body.mail.error);
      else sendSignedMail(body.mail.payload, body.mail.sig);
    } catch (e) { Logger.log('Mail failed: ' + e.message); }
  }
  if (!body.ok) throw new Error(body.error || 'Backend error.');
  return body.result;
}

// ==========================================
// PAGE
// ==========================================

function doGet(e) {
  const p = (e && e.parameter) || {};
  const params = {};
  ['page', 'ticketKey', 'date', 'shift', 'task'].forEach(function (k) { if (p[k]) params[k] = String(p[k]); });

  // Google lets each person untick permissions on the consent screen. Without "Connect to an external
  // service" the front cannot reach the backend, so ask for the missing permission instead of failing.
  const perm = frontPermissionStatus_();
  if (!perm.complete) return permissionPage_(perm);

  let body;
  try {
    body = callBackendRaw_('page', [params]);
  } catch (err) {
    if (/do not have permission to call|Required permissions:/i.test(String(err.message || err))) {
      return permissionPage_(frontPermissionStatus_(true));
    }
    return simplePage_('The app is not available right now', String(err.message || err));
  }
  if (!body.ok) return simplePage_('The app is not available right now', body.error || 'Backend error.');
  const r = body.result || {};
  if (!r.registered) {
    return simplePage_('Access required',
      'This account is not registered for this application: ' + (r.email || 'unknown account') +
      '. Ask the application owner to add your account.');
  }

  const cfg = JSON.stringify({ url: backendUrl_(), token: ScriptApp.getIdentityToken(), initialData: r.initialData || null })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = String(r.html || '').replace(/<head([^>]*)>/i, function (m) {
    return m + '<script>window.WFM_API=' + cfg + ';</script>';
  });

  return HtmlService.createHtmlOutput(html)
    .setTitle('WFM Operations App')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/** The permissions in appsscript.json, with the wording Google shows on its consent screen. */
const FRONT_SCOPES_ = {
  'https://www.googleapis.com/auth/script.external_request': 'Connect to an external service',
  'https://www.googleapis.com/auth/script.send_mail': 'Send email as you',
  'https://www.googleapis.com/auth/userinfo.email': 'See your email address'
};

/** { complete, missing: [names], url }. If Google's check itself fails it reports complete (never blocks). */
function frontPermissionStatus_(forceIncomplete) {
  try {
    const scopes = Object.keys(FRONT_SCOPES_);
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, scopes);
    const required = info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED;
    if (!required && !forceIncomplete) return { complete: true, missing: [], url: '' };
    let granted = null;
    try { granted = info.getAuthorizedScopes(); } catch (e) {}
    const missing = granted ? scopes.filter(function (k) { return granted.indexOf(k) === -1; }) : [];
    return {
      complete: false,
      missing: missing.length ? missing.map(function (k) { return FRONT_SCOPES_[k]; }) : ['Connect to an external service'],
      url: info.getAuthorizationUrl() || ''
    };
  } catch (e) {
    return forceIncomplete ? { complete: false, missing: ['Connect to an external service'], url: '' } : { complete: true, missing: [], url: '' };
  }
}

function permissionPage_(perm) {
  const esc = function (v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  let appUrl = '';
  try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  const btn = 'display:inline-block;margin:8px 4px;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700;';
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>One more step</title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e5e7eb;font-family:Arial,sans-serif">' +
    '<div style="max-width:470px;padding:32px;text-align:center"><h2 style="margin:0 0 12px">One more step</h2>' +
    '<p style="color:#9ca3af;line-height:1.55">The app needs a Google permission you did not tick: <b style="color:#e5e7eb">' +
    esc(perm.missing.join(', ')) + '</b>.<br>Click the button, choose your work account, <b style="color:#e5e7eb">tick every box</b> and click Continue. Then open the app again.</p>' +
    (perm.url ? '<a href="' + esc(perm.url) + '" target="_blank" rel="noopener" style="' + btn + 'background:#4f46e5;color:#fff">Grant permission</a>' : '') +
    (appUrl ? '<a href="' + esc(appUrl) + '" target="_top" style="' + btn + 'border:1px solid #4f46e5;color:#c7d2fe">Open the app</a>' : '') +
    (perm.url ? '' : '<p style="color:#9ca3af;font-size:13px;margin-top:18px">If there is no button: open myaccount.google.com/connections, remove "WFM App - Front", then open the app again and tick every box.</p>') +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('One more step');
}

function simplePage_(title, message) {
  const esc = function (v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e5e7eb;font-family:Arial,sans-serif">' +
    '<div style="max-width:440px;padding:32px;text-align:center"><h2 style="margin:0 0 12px">' + esc(title) + '</h2>' +
    '<p style="color:#9ca3af;line-height:1.5">' + esc(message) + '</p>' +
    (url ? '<p><a href="' + esc(url) + '" target="_top" style="display:inline-block;margin-top:12px;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600">Try again</a></p>' : '') +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title);
}

/** A fresh identity token for the page (tokens last about an hour). */
function getIdToken() {
  return ScriptApp.getIdentityToken();
}

// ==========================================
// EMAIL (sent from the signed-in person's own account)
// ==========================================

const MAIL_FIELDS_ = ['to', 'cc', 'bcc', 'subject', 'htmlBody', 'body', 'replyTo', 'name'];
const MAIL_MAX_JOBS_ = 20;

/**
 * Sends the messages the backend queued and signed. Refuses anything not signed with
 * MAIL_SIGNING_KEY, signed for another account, expired, or already sent.
 * Returns { sent, failed, error }.
 */
function sendSignedMail(payload, sig) {
  const key = PropertiesService.getScriptProperties().getProperty('MAIL_SIGNING_KEY');
  if (!key) throw new Error('Email is not set up in the front app (MAIL_SIGNING_KEY missing).');
  payload = String(payload || '');
  if (!payload || payload.length > 2000000) throw new Error('Email request rejected.');

  const expected = Utilities.base64Encode(Utilities.computeHmacSha256Signature(payload, key));
  if (!sameText_(expected, String(sig || ''))) throw new Error('Email request rejected (bad signature).');

  const p = JSON.parse(payload);
  const me = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  if (!me || p.from !== me) throw new Error('Email request rejected (it was prepared for another account).');
  if (!(Number(p.exp) > Date.now())) throw new Error('Email request expired.');

  const cache = CacheService.getUserCache();
  const seenKey = 'MJ_' + String(p.nonce || '').substring(0, 60);
  if (cache.get(seenKey)) return { sent: 0, failed: 0, error: null, duplicate: true };
  cache.put(seenKey, '1', 1800);

  const jobs = Array.isArray(p.jobs) ? p.jobs.slice(0, MAIL_MAX_JOBS_) : [];
  let sent = 0, failed = 0, error = null;
  jobs.forEach(function (job) {
    const msg = {};
    MAIL_FIELDS_.forEach(function (f) { if (job && job[f]) msg[f] = String(job[f]); });
    if (!msg.to || !msg.subject) return;
    const recipients = [msg.to, msg.cc, msg.bcc].filter(Boolean).join(',').split(',').filter(String).length;
    try {
      const remaining = MailApp.getRemainingDailyQuota();
      if (remaining < recipients) {
        failed++;
        error = 'Your daily email quota is used up (' + remaining + ' left). Your change was saved.';
        return;
      }
      MailApp.sendEmail(msg);
      sent++;
    } catch (e) {
      failed++;
      error = /permission|Required permissions/i.test(String(e.message))
        ? 'You did not allow this app to send email as you. Open the app again and tick every box on Google\'s screen. Your change was saved.'
        : 'Notification could not be sent. Your change was saved.';
    }
  });
  return { sent: sent, failed: failed, error: error };
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ==========================================
// SLOW-ROUTE STUBS
// Used only if the browser cannot take the fast route (ApiShim reports it in the console).
// Same names as the backend's API_FUNCS_, so the pages work either way.
// ==========================================

function getInitialAppData() { return callBackend_('getInitialAppData', Array.prototype.slice.call(arguments)); }
function checkSystemSync() { return callBackend_('checkSystemSync', Array.prototype.slice.call(arguments)); }
function getAttachmentFileBlob() { return callBackend_('getAttachmentFileBlob', Array.prototype.slice.call(arguments)); }
function getDayBundle() { return callBackend_('getDayBundle', Array.prototype.slice.call(arguments)); }
function getTasksForShift() { return callBackend_('getTasksForShift', Array.prototype.slice.call(arguments)); }
function updateTaskField() { return callBackend_('updateTaskField', Array.prototype.slice.call(arguments)); }
function updateTodoCommentWithFiles() { return callBackend_('updateTodoCommentWithFiles', Array.prototype.slice.call(arguments)); }
function closeShift() { return callBackend_('closeShift', Array.prototype.slice.call(arguments)); }
function reopenShift() { return callBackend_('reopenShift', Array.prototype.slice.call(arguments)); }
function exportRawSheetToCsv() { return callBackend_('exportRawSheetToCsv', Array.prototype.slice.call(arguments)); }
function invalidateWfmCaches() { return callBackend_('invalidateWfmCaches', Array.prototype.slice.call(arguments)); }
function getTickets() { return callBackend_('getTickets', Array.prototype.slice.call(arguments)); }
function getTicketActivity() { return callBackend_('getTicketActivity', Array.prototype.slice.call(arguments)); }
function createTicket() { return callBackend_('createTicket', Array.prototype.slice.call(arguments)); }
function updateTicket() { return callBackend_('updateTicket', Array.prototype.slice.call(arguments)); }
function addTicketComment() { return callBackend_('addTicketComment', Array.prototype.slice.call(arguments)); }
function getAssistantStatus() { return callBackend_('getAssistantStatus', Array.prototype.slice.call(arguments)); }
function askAssistant(messages, options) {
  if (options && options.includeTodos === true) {
    try { options = Object.assign({}, options, { todos: getMyTodos() }); } catch (e) {}
  }
  return callBackend_('askAssistant', [messages, options]);
}
function getAiSettings() { return callBackend_('getAiSettings', Array.prototype.slice.call(arguments)); }
function saveAiSettings() { return callBackend_('saveAiSettings', Array.prototype.slice.call(arguments)); }
function testAiProvider() { return callBackend_('testAiProvider', Array.prototype.slice.call(arguments)); }
function getReportingCatalog() { return callBackend_('getReportingCatalog', Array.prototype.slice.call(arguments)); }
function runVoycePerformanceReport() { return callBackend_('runVoycePerformanceReport', Array.prototype.slice.call(arguments)); }
function runAutomatedVoyceReports() { return callBackend_('runAutomatedVoyceReports', Array.prototype.slice.call(arguments)); }
function getDashboardMenu() { return callBackend_('getDashboardMenu', Array.prototype.slice.call(arguments)); }
function getVoyceDashboardData() { return callBackend_('getVoyceDashboardData', Array.prototype.slice.call(arguments)); }
function getVoyceDashboardStamp() { return callBackend_('getVoyceDashboardStamp', Array.prototype.slice.call(arguments)); }
function loadVoyceOnlineHours() { return callBackend_('loadVoyceOnlineHours', Array.prototype.slice.call(arguments)); }
function getAdherenceDashboardData() { return callBackend_('getAdherenceDashboardData', Array.prototype.slice.call(arguments)); }
function getAdherenceDashboardStamp() { return callBackend_('getAdherenceDashboardStamp', Array.prototype.slice.call(arguments)); }
function adhStartRun() { return callBackend_('adhStartRun', Array.prototype.slice.call(arguments)); }
function adhSaveReport() { return callBackend_('adhSaveReport', Array.prototype.slice.call(arguments)); }
function adhReportRunFailure() { return callBackend_('adhReportRunFailure', Array.prototype.slice.call(arguments)); }
function getMvccDashboardData() { return callBackend_('getMvccDashboardData', Array.prototype.slice.call(arguments)); }
function getMvccDashboardStamp() { return callBackend_('getMvccDashboardStamp', Array.prototype.slice.call(arguments)); }
function mvccBackfillSisense() { return callBackend_('mvccBackfillSisense', Array.prototype.slice.call(arguments)); }
function mvccStartPaidHours() { return callBackend_('mvccStartPaidHours', Array.prototype.slice.call(arguments)); }
function mvccSavePaidHours() { return callBackend_('mvccSavePaidHours', Array.prototype.slice.call(arguments)); }
function mvccReportRunFailure() { return callBackend_('mvccReportRunFailure', Array.prototype.slice.call(arguments)); }

// ==========================================
// SETUP CHECK (run from the editor)
// ==========================================

/** Prints what is set up and asks the backend who you are. Run it once after setting the properties. */
function checkFrontSetup() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('BACKEND_URL: ' + (props.getProperty('BACKEND_URL') ? 'set' : 'MISSING'));
  Logger.log('MAIL_SIGNING_KEY: ' + (props.getProperty('MAIL_SIGNING_KEY') ? 'set' : 'MISSING'));
  Logger.log('Backend says: ' + JSON.stringify(callBackendRaw_('whoami', [])));
}

/** Prints the value for the backend's API_ALLOWED_AUD script property. */
function showMyAudience() {
  let part = ScriptApp.getIdentityToken().split('.')[1];
  while (part.length % 4) part += '=';
  const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(part)).getDataAsString());
  Logger.log('API_ALLOWED_AUD = ' + claims.aud);
}
