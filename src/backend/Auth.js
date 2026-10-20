/**
 * Auth.gs
 * Identity and authorization helpers for the "Execute as: User accessing the web app" model.
 *
 * WHY Session.getActiveUser() IS THE IDENTITY (and getEffectiveUser() IS ONLY A MODE CHECK)
 * - In "Execute as: User accessing the web app" mode both calls return the visiting user.
 * - In legacy "Execute as: Me" mode getEffectiveUser() returns the OWNER for every visitor.
 *   If we ever fell back to it for identity, a visitor with a blank active email would be
 *   treated as the owner (an Admin). So identity always comes from getActiveUser() only.
 * - Comparing the two tells us which mode we are really running in, so features that must be
 *   per-user (personal To-Do, sending mail as the user) can refuse to run in the wrong mode.
 */

function normalizeEmail_(value) {
  return String(value || '').toLowerCase().trim();
}

/** The signed-in Google account of the person using the web app ('' if unknown). */
function currentUserEmail_() {
  if (typeof API_REQUEST_EMAIL_ !== 'undefined' && API_REQUEST_EMAIL_) return API_REQUEST_EMAIL_;
  try {
    return normalizeEmail_(Session.getActiveUser().getEmail());
  } catch (e) {
    return '';
  }
}

/** Reports how the web app is executing. */
function getAuthMode_() {
  const active = currentUserEmail_();
  let effective = '';
  try { effective = normalizeEmail_(Session.getEffectiveUser().getEmail()); } catch (e) {}
  return {
    active: active,
    effective: effective,
    executesAsUser: !!active && active === effective
  };
}

/** Current user with role. role is null when the account is not in the Roles sheet. */
function getCurrentUser_() {
  const email = currentUserEmail_();
  const role = email ? (getRolesDirectory_().byEmail[email] || null) : null;
  return {
    email: email,
    role: role,
    isRegistered: !!role,
    isElevated: role === 'Manager' || role === 'Admin',
    isAdmin: role === 'Admin'
  };
}

function requireRegistered_() {
  const user = getCurrentUser_();
  if (!user.isRegistered) throw new Error('Unauthorized account.');
  return user;
}

function requireElevated_() {
  const user = requireRegistered_();
  if (!user.isElevated) throw new Error('Unauthorized: this action is restricted to Managers and Admins.');
  return user;
}

function requireAdmin_() {
  const user = requireRegistered_();
  if (!user.isAdmin) throw new Error('Unauthorized: this action is restricted to Admins.');
  return user;
}

/** Features that must be per-user refuse to run when the deployment is not in user mode. */
function requireUserMode_(featureName) {
  const mode = getAuthMode_();
  if (!mode.executesAsUser) {
    throw new Error(
      (featureName || 'This feature') + ' requires the web app to run as "User accessing the web app". ' +
      'Ask an Admin to check the deployment settings.'
    );
  }
  return mode;
}

/** Splits "a@x.com, b@y.com; c@z.com" (or an array) into unique lowercase emails. */
function normalizeEmailList_(value) {
  let parts = [];
  if (Array.isArray(value)) {
    parts = value;
  } else {
    parts = String(value || '').split(/[,;\n]/);
  }
  const seen = {};
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const email = normalizeEmail_(parts[i]);
    if (!email || seen[email]) continue;
    seen[email] = true;
    out.push(email);
  }
  return out;
}

function assertDateStr_(dateStr) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid date.');
  const y = Number(s.substr(0, 4)), m = Number(s.substr(5, 2)), d = Number(s.substr(8, 2));
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new Error('Invalid date.');
  }
  return s;
}

function assertShift_(shift) {
  const s = String(shift || '').trim();
  if (CONFIG.SHIFTS.indexOf(s) === -1) throw new Error('Invalid shift.');
  return s;
}

/** Web app URL used in email deep links. Set once by an Admin (see Setup.gs). */
function getWebAppUrl_() {
  // Only a deployed /exec link works for everyone; the editor's /dev test link works for editors only.
  const isExec = function (u) { return /\/exec$/.test(String(u || '')); };
  try {
    const configured = PropertiesService.getScriptProperties().getProperty('WFM_WEBAPP_URL');
    if (isExec(configured)) return configured;
  } catch (e) {}
  try {
    const url = ScriptApp.getService().getUrl() || '';
    return isExec(url) ? url : '';
  } catch (e) {
    return '';
  }
}

/** Server-side include for HtmlService templates (Styles.html, ToDo.html). */
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(String(filename)).getContent();
}

// ==========================================
// PERMISSIONS EACH PERSON GRANTED (granular consent)
// ==========================================
//
// Google's consent screen lets each person tick or untick every permission separately. The app still
// opens with a permission unticked, but anything that needs it fails for that person only, with
// Google's message "You do not have permission to call DriveApp.getFileById. Required permissions: ...".
// Sharing folders cannot fix that: it is the person's permission to the APP. So the app checks at
// start-up and offers a one-click fix (Google's own authorization page for the missing permissions).

/** The scopes in appsscript.json, with the wording Google uses on its consent screen. */
const REQUIRED_SCOPES_ = {
  'https://www.googleapis.com/auth/spreadsheets': 'Google Sheets',
  'https://www.googleapis.com/auth/drive': 'Google Drive',
  'https://www.googleapis.com/auth/script.send_mail': 'Send email as you',
  'https://www.googleapis.com/auth/userinfo.email': 'See your email address',
  'https://www.googleapis.com/auth/script.external_request': 'Connect to an external service'
};

/**
 * { complete, missing: [names], url } for the signed-in person. Never blocks the app: if Google's
 * check itself is unavailable, it reports complete and the plain-language error messages below
 * still explain the problem when it happens.
 */
function getPermissionStatus_() {
  try {
    const scopes = Object.keys(REQUIRED_SCOPES_);
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, scopes);
    if (info.getAuthorizationStatus() !== ScriptApp.AuthorizationStatus.REQUIRED) {
      return { complete: true, missing: [], url: '' };
    }
    let granted = null;
    try { granted = info.getAuthorizedScopes(); } catch (e) {}
    const missing = granted ? scopes.filter(function (s) { return granted.indexOf(s) === -1; }) : [];
    return {
      complete: false,
      missing: missing.length ? missing.map(function (s) { return REQUIRED_SCOPES_[s]; }) : ['some permissions'],
      url: info.getAuthorizationUrl() || ''
    };
  } catch (e) {
    return { complete: true, missing: [], url: '', checked: false };
  }
}

/** True for Google's "permission not granted" errors (not for sharing errors). */
function isPermissionError_(err) {
  return /do not have permission to call|Required permissions:/i.test(String((err && err.message) || err || ''));
}

/** Plain-language replacement for Google's permission error. */
function permissionErrorMessage_(what) {
  return 'Your Google permission for this app does not include ' + (what || 'Google Drive') + ', so this cannot work for you yet. ' +
    'Click "Grant permissions" at the top of the app (or reload it) and tick every box on Google\'s screen. ' +
    'Sharing the folder does not fix this; it is your permission to the app.';
}