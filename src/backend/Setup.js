/**
 * Setup.gs
 * One-time and diagnostic functions for the Admin / spreadsheet owner.
 * Run them from the Apps Script editor (Run menu). Each one refuses to run for anyone else, so
 * exposing them to the browser (all top-level functions are) does not open a hole.
 */

function isSpreadsheetOwner_() {
  try {
    const owner = SpreadsheetApp.getActiveSpreadsheet().getOwner();
    return !!owner && normalizeEmail_(owner.getEmail()) === currentUserEmail_();
  } catch (e) {
    return false;
  }
}

/** Allows a registered Admin, or the spreadsheet owner (needed on the very first run). */
function requireSetupAccess_() {
  const user = getCurrentUser_();
  if (user.isAdmin || isSpreadsheetOwner_()) return user;
  throw new Error('Unauthorized: setup functions are restricted to Admins and the spreadsheet owner.');
}

/**
 * STEP 1 (run once after the new deployment): creates any missing tabs (including
 * "Notification Log"), resolves the attachments folder, and stores the web app URL for email links.
 */
function setupDeployment() {
  requireSetupAccess_();
  const report = [];

  initializeDatabase_();
  PropertiesService.getScriptProperties().setProperty('WFM_SCHEMA_READY', 'v3');
  report.push('Sheets verified/created (Roles, Daily Tasks, Todo List, Tickets, Shift Closures, Notification Log).');

  const folder = getCachedAttachmentsFolder();
  report.push('Attachments folder ready: "' + folder.getName() + '" (' + folder.getId() + ').');

  const configured = PropertiesService.getScriptProperties().getProperty('WFM_WEBAPP_URL');
  if (!configured) {
    let url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
    // Run from the editor, getUrl() returns the private test link (/dev). Only a deployed /exec link is usable by everyone.
    if (/\/exec$/.test(url)) {
      PropertiesService.getScriptProperties().setProperty('WFM_WEBAPP_URL', url);
      report.push('Web app URL stored: ' + url);
    } else {
      report.push('ACTION NEEDED: no deployed /exec URL is known yet (the editor only knows the private test link). After deploying, run setWebAppUrl("https://script.google.com/.../exec").');
    }
  } else {
    report.push('Web app URL already set: ' + configured);
    if (!/\/exec$/.test(configured)) report.push('WARNING: the stored URL is not a deployed /exec link and will not open for other people. Run setWebAppUrl with the /exec URL.');
  }

  clearCaches_();
  Logger.log(report.join('\n'));
  return report;
}

/** Stores the /exec URL used in email deep links. Example: setWebAppUrl('https://script.google.com/macros/s/AKfy.../exec') */
function setWebAppUrl(url) {
  requireSetupAccess_();
  const clean = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.\-]+\/|a\/[A-Za-z0-9.\-]+\/macros\/|macros\/)s\/[A-Za-z0-9_\-]+\/exec$/.test(clean)) {
    throw new Error('That does not look like a web app /exec URL. It must start with https://script.google.com/ and end with /exec (no /dev, no extra text). You pasted: ' + clean.substring(0, 120));
  }
  PropertiesService.getScriptProperties().setProperty('WFM_WEBAPP_URL', clean);
  Logger.log('Web app URL stored: ' + clean);
  return { success: true, url: clean };
}

/**
 * OPTIONAL (run once, before shareWithTeam): accounts that only RECEIVE email, such as a shared team mailbox.
 * They stay in Roles, so they remain valid as ticket assignee, CC and mention recipients, but they are never
 * granted Editor access to the spreadsheet or the attachments folder.
 * Example: setNotifyOnlyAccounts(['team-mailbox@example.com'])
 */
function setNotifyOnlyAccounts(emails) {
  requireSetupAccess_();
  const list = normalizeEmailList_(emails);
  list.forEach(function (e) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Not a valid email address: ' + e);
  });
  const inRoles = getRolesDirectory_().list.map(function (u) { return u.email; });
  const notInRoles = list.filter(function (e) { return inRoles.indexOf(e) === -1; });
  PropertiesService.getScriptProperties().setProperty('WFM_NOTIFY_ONLY', list.join(','));
  Logger.log('Notify-only accounts: ' + (list.join(', ') || '(none)') +
    (notInRoles.length ? '  WARNING, not in the Roles sheet (so they cannot be assigned or CC\'d): ' + notInRoles.join(', ') : ''));
  return { success: true, notifyOnly: list, notInRoles: notInRoles };
}

function getNotifyOnlyList_() {
  return normalizeEmailList_(PropertiesService.getScriptProperties().getProperty('WFM_NOTIFY_ONLY') || '');
}

/**
 * STEP 2 (run once): because the app now runs as each user, every person in the Roles sheet
 * needs Editor access to the spreadsheet AND the attachments folder. This grants it.
 * Google sends each person the usual "shared with you" email.
 */
function shareWithTeam() {
  requireSetupAccess_();
  if (PropertiesService.getScriptProperties().getProperty('WFM_LOCKED_DOWN')) {
    throw new Error('Not done: the app is locked down (only the owner may access the sheet and the attachments folder). ' +
      'The app works for everyone through the new link without sharing anything.');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = getCachedAttachmentsFolder();
  const owner = currentUserEmail_();
  const report = { granted: [], failed: [], skippedNotifyOnly: [] };
  const notifyOnly = getNotifyOnlyList_();

  getRolesDirectory_().list.forEach(function (u) {
    if (u.email === owner) return;
    if (notifyOnly.indexOf(u.email) !== -1) { report.skippedNotifyOnly.push(u.email); return; }
    try {
      ss.addEditor(u.email);
      folder.addEditor(u.email);
      report.granted.push(u.email);
    } catch (e) {
      report.failed.push({ email: u.email, error: String(e.message || e) });
    }
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Read-only health check. Run it after deployment and after every user reports a problem. */
function checkSetup() {
  requireSetupAccess_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mode = getAuthMode_();
  const directory = getRolesDirectory_();
  const out = {
    executesAsUser: mode.executesAsUser,
    runningAs: mode.active,
    effectiveUser: mode.effective,
    rolesCount: directory.list.length,
    admins: directory.list.filter(function (u) { return u.role === 'Admin'; }).length,
    sheetsPresent: [],
    sheetsMissing: [],
    webAppUrl: PropertiesService.getScriptProperties().getProperty('WFM_WEBAPP_URL') || '(not set)',
    mailQuotaRemaining: MailApp.getRemainingDailyQuota(),
    notes: []
  };

  [CONFIG.SHEETS.ROLES, CONFIG.SHEETS.DAILY_TASKS, CONFIG.SHEETS.TODO_LIST, CONFIG.SHEETS.TICKETS,
   CONFIG.SHEETS.SHIFT_CLOSURES, CONFIG.SHEETS.NOTIFY_LOG].forEach(function (name) {
    (ss.getSheetByName(name) ? out.sheetsPresent : out.sheetsMissing).push(name);
  });

  try {
    const folder = getCachedAttachmentsFolder();
    out.attachmentsFolder = folder.getName() + ' (' + folder.getId() + ')';
    const folderEditors = folder.getEditors().map(function (u) { return normalizeEmail_(u.getEmail()); });
    const sheetEditors = ss.getEditors().map(function (u) { return normalizeEmail_(u.getEmail()); });
    const ownerEmail = ss.getOwner() ? normalizeEmail_(ss.getOwner().getEmail()) : '';
    const missingSheet = [], missingFolder = [];
    const notifyOnly = getNotifyOnlyList_();
    out.notifyOnlyAccounts = notifyOnly;
    directory.list.forEach(function (u) {
      if (u.email === ownerEmail) return;
      if (notifyOnly.indexOf(u.email) !== -1) return;
      if (sheetEditors.indexOf(u.email) === -1) missingSheet.push(u.email);
      if (folderEditors.indexOf(u.email) === -1) missingFolder.push(u.email);
    });
    out.missingSpreadsheetEditors = missingSheet;
    out.missingFolderEditors = missingFolder;
    if (missingSheet.length || missingFolder.length) {
      if (!PropertiesService.getScriptProperties().getProperty('WFM_LOCKED_DOWN')) out.notes.push('Listed people lack direct Editor access. If access is granted through a Google Group or domain-wide sharing this list can be a false alarm. Otherwise run shareWithTeam().');
    }
  } catch (e) {
    out.attachmentsFolder = 'NOT ACCESSIBLE: ' + e.message;
  }

  if (!mode.executesAsUser) {
    out.notes.push('The deployment is NOT running as the visiting user. Emails would leave from the owner and the personal To-Do is disabled. Check Deploy > Manage deployments: Execute as = "User accessing the web app".');
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}