/**
 * WFM Operations App - Backend Engine
 * Production Build with Smart Delta Polling & Real-Time Sync
 * Platform: Google Apps Script Web App
 * Execution model: "Execute as: User accessing the web app" (every person signs in with their own
 *   Google account; email is sent from that person's own address).
 * Database: Google Sheets (Roles, Daily Tasks, Todo List, Tickets, Shift Closures, Notification Log)
 * File Storage: Google Drive ("WFM Operations - Attachments")
 *
 * File map: Code.gs (core) | Auth.gs (identity + role guards) | DayBundle.gs (fast loading)
 *           Notify.gs (all email) | PersonalTodo.gs (private My To-Do) | Setup.gs (admin tools)
 */

const CONFIG = {
  SHEETS: {
    ROLES: 'Roles',
    DAILY_TASKS: 'Daily Tasks',
    TODO_LIST: 'Todo List',
    TICKETS: 'Tickets',
    SHIFT_CLOSURES: 'Shift Closures',
    NOTIFY_LOG: 'Notification Log'
  },
  DRIVE_FOLDER: 'WFM Operations - Attachments',
  SHIFTS: ['Morning', 'Mid', 'Overnight'],
  TODO_STATUSES: ['Pending', 'Completed', 'Cancelled'],
  TICKET_TYPES: ['Issue', 'Task', 'Flags'],
  TICKET_STATUSES: ['Open', 'In Progress', 'Completed', 'Cancelled'],

  CACHE_TTL_MASTER_TASKS: 300,
  CACHE_TTL_ROLES: 60,
  CACHE_TTL_DAY: 900,
  LOCK_TIMEOUT_MS: 15000,

  TODO_COLS: { DATE: 1, TASK: 2, SHIFT: 3, ASSIGNED: 4, RECEIVED: 5, STATUS: 6, COMMENT: 7, ATTACHMENTS: 8 },
  TICKET_COLS: { CREATED: 1, TYPE: 2, ASSIGNED_TO: 3, ASSIGNED_BY: 4, DESC: 5, CC: 6, STATUS: 7, UPDATED: 8, PUBLIC: 9, ATTACHMENTS: 10 }
};

const ROLES_CACHE_KEY = 'WFM_ROLES_V2';

let _rolesDirectoryExecutionCache = null;

// ==========================================
// WEB APP ENTRY POINT
// ==========================================

/**
 * R-21: a visitor who is not in the Roles sheet (or cannot read it) receives only this small page.
 * The app's markup, styles and scripts are never sent to them. Data is still protected separately
 * by the server-side checks in every public function.
 */
function buildAccessDeniedPage_(email) {
  function esc(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  let appUrl = '';
  try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (err) { appUrl = ''; }
  const who = email ? esc(email) : 'an account Google did not identify';
  const retry = appUrl
    ? '<p><a href="' + esc(appUrl) + '" target="_top" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600">Re-check access</a></p>'
    : '';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Access required</title></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e5e7eb;font-family:Arial,sans-serif">'
    + '<div style="max-width:420px;padding:32px;text-align:center">'
    + '<h2 style="margin:0 0 12px">Access required</h2>'
    + '<p style="margin:0 0 8px;color:#9ca3af">This account is not registered for this application.</p>'
    + '<p style="margin:0 0 20px;font-weight:600">' + who + '</p>'
    + retry
    + '<p style="margin-top:20px;font-size:13px;color:#9ca3af">Ask the application owner to add your account.</p>'
    + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Access required')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function doGet(e) {
  // R-21 gate: only registered accounts are given the application page.
  // The backend deployment ("Execute as: Me") must never serve the page as the owner.
  // Plain text, never an HtmlService page: any page served by the "Execute as: Me" deployment would let a
  // visitor call the server functions through google.script.run AS THE OWNER (bypassing the API gate).
  if (!isSameUserExecution_()) {
    return ContentService.createTextOutput('WFM Operations: this address is not the app. Use the link you were given.');
  }

  // After the switch to the new app (script property WFM_OLD_APP_MODE = redirect) this old link only
  // points people to the new app. "?legacy=1" still opens the old app (used to export My To-Do).
  if (isMovedMode_() && !(e && e.parameter && e.parameter.legacy === '1')) return buildMovedPage_(e && e.parameter);

  let registered = false;
  try { registered = !!getCurrentUser_().isRegistered; } catch (err) { registered = false; }
  if (!registered) return buildAccessDeniedPage_(currentUserEmail_());

  return buildAppTemplate_(e && e.parameter).evaluate()
    .setTitle('WFM Operations App')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function isMovedMode_() {
  try { return PropertiesService.getScriptProperties().getProperty('WFM_OLD_APP_MODE') === 'redirect'; } catch (e) { return false; }
}

/** Small page that sends people to the new app (same deep-link parameters). It never touches the sheets. */
function buildMovedPage_(params) {
  function esc(v) {
    return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  params = params || {};
  const props = PropertiesService.getScriptProperties();
  const target = String(props.getProperty('WFM_WEBAPP_URL') || '');
  const oldUrl = String(props.getProperty('WFM_OLD_APP_URL') || '');   // used only to avoid a redirect loop
  let current = '';
  try { current = ScriptApp.getService().getUrl() || ''; } catch (err) { current = ''; }
  const ready = /^https:\/\/script\.google\.com\/.+\/exec$/.test(target) && target !== current && target !== oldUrl;

  const qs = [];
  ['page', 'ticketKey', 'date', 'shift', 'task'].forEach(function (k) {
    if (params[k]) qs.push(k + '=' + encodeURIComponent(String(params[k]).substring(0, 200)));
  });
  const newLink = ready ? target + (qs.length ? '?' + qs.join('&') : '') : '';
  // The visitor's own private My To-Do tasks (this deployment runs as the visitor, so this is their store).
  // Read straight from their private storage: no sheet access needed, so it still works after the lockdown.
  let myTasks = [];
  try {
    myTasks = ptReadAll_(PropertiesService.getUserProperties()).map(function (t) {
      return { id: t.id, title: t.title, notes: t.notes || '', priority: t.priority, category: t.category,
               dueDate: t.dueDate || '', completed: !!t.completed, createdAt: t.createdAt };
    });
  } catch (err) { myTasks = []; }
  const tasksJson = JSON.stringify(myTasks).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  const button = 'display:inline-block;padding:12px 22px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:700';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>WFM Operations has moved</title></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e5e7eb;font-family:Arial,sans-serif">'
    + '<div style="max-width:440px;padding:32px;text-align:center">'
    + '<h2 style="margin:0 0 12px">WFM Operations has a new home</h2>'
    + '<p style="margin:0 0 22px;color:#9ca3af;line-height:1.5">This is the old link. The app now runs at a new, more secure address. Your account, role and everything in the app are unchanged.</p>'
    + (newLink ? '<p><a href="' + esc(newLink) + '" target="_top" style="' + button + '">Open the new app</a></p>'
                : '<p style="color:#fbbf24">The new app link is not set yet. Ask the application owner.</p>')
    + (myTasks.length
        ? '<div style="margin-top:28px;padding:16px;border:1px solid #374151;border-radius:10px;font-size:13px;color:#9ca3af;line-height:1.5">'
          + 'You have <b style="color:#e5e7eb">' + myTasks.length + ' private task' + (myTasks.length === 1 ? '' : 's') + '</b> in My To-Do.<br>'
          + '<button type="button" id="dl" style="margin:10px 0;padding:8px 16px;border-radius:8px;border:1px solid #6366f1;background:transparent;color:#c7d2fe;font-weight:700;cursor:pointer">Download my tasks</button><br>'
          + 'Then in the new app open <b>My To-Do</b> and click <b>Import tasks</b>.</div>'
          + '<script>(function(){var tasks=' + tasksJson + ';document.getElementById("dl").onclick=function(){'
          + 'var d=new Date(),p=function(n){return(n<10?"0":"")+n;};'
          + 'var blob=new Blob([JSON.stringify({app:"wfm-ops-my-todo",version:1,exportedAt:d.toISOString(),tasks:tasks},null,2)],{type:"application/json"});'
          + 'var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="my-todo-"+d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+".json";'
          + 'document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1500);};})();</script>'
        : '')
    + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('WFM Operations has moved')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

/**
 * The app page template for the given URL parameters. Used by doGet (old deployment) and by the
 * backend API's "page" action (the new front app asks for the page through it).
 */
function buildAppTemplate_(params) {
  params = params || {};
  const template = HtmlService.createTemplateFromFile('Index');

  const rawPage = params.page ? String(params.page) : 'todo';
  const rawKey = params.ticketKey ? String(params.ticketKey) : '';

  // 'mytodo' is kept for links sent before My To-Do moved into Personal Assistant.
  const PAGES = ['todo', 'tickets', 'mytodo', 'assistant', 'reporting'];
  // Dashboards are pages named 'dash-<id>' (see Dashboards.gs); the page itself checks the role on the server.
  const isDashPage = /^dash-[a-z0-9-]{1,40}$/.test(rawPage);
  const initialPage = (PAGES.indexOf(rawPage) !== -1 || isDashPage) ? rawPage : 'todo';
  const initialTicketKey = rawKey.replace(/[^0-9A-Za-z:.\-TZ+]/g, '').substring(0, 40);

  // Optional deep link to one to-do item (used by the @mention emails).
  let todoDate = '', todoShift = '', todoTask = '';
  try {
    if (params.date || params.shift || params.task) {
      todoDate = assertDateStr_(params.date);
      todoShift = assertShift_(params.shift);
      todoTask = String(params.task || '').substring(0, 120);
    }
  } catch (err) {
    todoDate = ''; todoShift = ''; todoTask = '';
  }
  if (!todoTask) { todoDate = ''; todoShift = ''; }

  // Kept for compatibility with anything that still reads these template variables.
  template.initialPage = initialPage;
  template.initialTicketKey = initialTicketKey;

  // Values reach the browser as JSON with <, >, & and line separators escaped (no HTML/JS injection).
  template.bootJson = JSON.stringify({
    page: initialPage,
    ticketKey: initialTicketKey,
    todoDate: todoDate,
    todoShift: todoShift,
    todoTask: todoTask
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  return template;
}

// ==========================================
// REAL-TIME MUTATION TRACKING
// ==========================================

function notifyMutation_(scope) {
  try {
    const props = PropertiesService.getScriptProperties();
    const now = Date.now().toString();
    if (scope === 'todo') {
      props.setProperty('WFM_MUTATION_TODO', now);
    } else if (scope === 'tickets') {
      props.setProperty('WFM_MUTATION_TICKETS', now);
    } else {
      props.setProperty('WFM_MUTATION_TODO', now);
      props.setProperty('WFM_MUTATION_TICKETS', now);
    }
  } catch (e) {}
}

function onEdit(e) {
  notifyMutation_('all');
  // Manual edits of Roles / Daily Tasks must take effect immediately, not after the cache expires.
  try {
    const name = e && e.range ? e.range.getSheet().getName() : '';
    const cache = CacheService.getScriptCache();
    if (name === CONFIG.SHEETS.ROLES) cache.remove(ROLES_CACHE_KEY);
    if (name === CONFIG.SHEETS.DAILY_TASKS) cache.remove('WFM_MASTER_V1');
  } catch (err) {}
}

/**
 * Lightweight sync endpoint that checks for changes across sessions without reading sheets.
 */
function checkSystemSync(clientTodoTime, clientTicketTime) {
  const props = PropertiesService.getScriptProperties();
  const serverTodo = Number(props.getProperty('WFM_MUTATION_TODO') || 0);
  const serverTicket = Number(props.getProperty('WFM_MUTATION_TICKETS') || 0);

  return {
    todoChanged: serverTodo > Number(clientTodoTime || 0),
    ticketsChanged: serverTicket > Number(clientTicketTime || 0),
    serverTodoTime: serverTodo,
    serverTicketTime: serverTicket
  };
}

// ==========================================
// REAL-TIME DIRECT DIRECTORY LOOKUP
// ==========================================

function getRolesDirectory_() {
  if (_rolesDirectoryExecutionCache) {
    return _rolesDirectoryExecutionCache;
  }

  const cache = CacheService.getScriptCache();
  const cachedList = cache.get(ROLES_CACHE_KEY);
  if (cachedList) {
    try {
      const list = JSON.parse(cachedList);
      const byEmail = {};
      list.forEach(function (u) { byEmail[u.email] = u.role; });
      _rolesDirectoryExecutionCache = { byEmail: byEmail, list: list };
      return _rolesDirectoryExecutionCache;
    } catch (e) {}
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.ROLES);
  if (!sheet) throw new Error('The Roles sheet is missing.');

  const lastRow = sheet.getLastRow();
  const directory = { byEmail: {}, list: [] };

  if (lastRow > 1) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      const email = String(rows[i][0] || '').toLowerCase().trim();
      const role = String(rows[i][1] || '').trim();
      if (!email) continue;
      if (directory.byEmail[email] !== undefined) continue;
      directory.byEmail[email] = role;
      directory.list.push({ email: email, role: role });
    }
  }

  try { cache.put(ROLES_CACHE_KEY, JSON.stringify(directory.list), CONFIG.CACHE_TTL_ROLES); } catch (e) {}
  _rolesDirectoryExecutionCache = directory;
  return directory;
}

function getMasterTasks_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('WFM_MASTER_V1');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DAILY_TASKS);
  const lastRow = sheet.getLastRow();
  const tasks = [];

  if (lastRow > 1) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < rows.length; i++) {
      const name = String(rows[i][0] || '').trim();
      const shift = String(rows[i][1] || '').trim();
      if (name && shift) tasks.push({ name: name, shift: shift });
    }
  }

  try { cache.put('WFM_MASTER_V1', JSON.stringify(tasks), CONFIG.CACHE_TTL_MASTER_TASKS); } catch (e) {}
  return tasks;
}

function clearCaches_() {
  _rolesDirectoryExecutionCache = null;
  const cache = CacheService.getScriptCache();
  cache.remove('WFM_ROLES_V1');
  cache.remove(ROLES_CACHE_KEY);
  cache.remove('WFM_MASTER_V1');
  notifyMutation_('all');
}

function invalidateWfmCaches() {
  requireElevated_();
  clearCaches_();
  return { success: true, message: 'All caches cleared successfully.' };
}

// ==========================================
// SCHEMA BOOTSTRAP
// ==========================================

function initializeDatabase_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let rolesSheet = ss.getSheetByName(CONFIG.SHEETS.ROLES);
  if (!rolesSheet) {
    rolesSheet = ss.insertSheet(CONFIG.SHEETS.ROLES);
    rolesSheet.appendRow(['Email', 'Role']);
    rolesSheet.setFrozenRows(1);
    rolesSheet.getRange('A1:B1').setFontWeight('bold');
    rolesSheet.appendRow([currentUserEmail_(), 'Admin']);
  }

  let masterSheet = ss.getSheetByName(CONFIG.SHEETS.DAILY_TASKS);
  if (!masterSheet) {
    masterSheet = ss.insertSheet(CONFIG.SHEETS.DAILY_TASKS);
    masterSheet.appendRow(['Task Name', 'Shift']);
    masterSheet.setFrozenRows(1);
    masterSheet.getRange('A1:B1').setFontWeight('bold');
  }

  let todoSheet = ss.getSheetByName(CONFIG.SHEETS.TODO_LIST);
  if (!todoSheet) {
    todoSheet = ss.insertSheet(CONFIG.SHEETS.TODO_LIST);
    todoSheet.appendRow(['Date', 'Task Name', 'Shift', 'Assigned To', 'Received By', 'Status', 'Comment', 'Attachments']);
    todoSheet.setFrozenRows(1);
    todoSheet.getRange('A1:H1').setFontWeight('bold');
  } else if (todoSheet.getLastColumn() < 8) {
    todoSheet.getRange(1, 8).setValue('Attachments').setFontWeight('bold');
  }

  let ticketsSheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
  if (!ticketsSheet) {
    ticketsSheet = ss.insertSheet(CONFIG.SHEETS.TICKETS);
    ticketsSheet.appendRow(['Created At', 'Ticket Type', 'Assigned To', 'Assigned By', 'Description', 'CC', 'Status', 'Updated At', 'Is Public', 'Attachments']);
    ticketsSheet.setFrozenRows(1);
    ticketsSheet.getRange('A1:J1').setFontWeight('bold');
  } else {
    if (ticketsSheet.getLastColumn() < 9) {
      ticketsSheet.getRange(1, 9).setValue('Is Public').setFontWeight('bold');
    }
    if (ticketsSheet.getLastColumn() < 10) {
      ticketsSheet.getRange(1, 10).setValue('Attachments').setFontWeight('bold');
    }
  }

  let closuresSheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
  if (!closuresSheet) {
    closuresSheet = ss.insertSheet(CONFIG.SHEETS.SHIFT_CLOSURES);
    closuresSheet.appendRow(['Date', 'Shift', 'Closed At', 'Closed By', 'Total Tasks', 'Completed Count', 'Cancelled Count', 'Handover Notes', 'Is Locked']);
    closuresSheet.setFrozenRows(1);
    closuresSheet.getRange('A1:I1').setFontWeight('bold');
  }

  let notifySheet = ss.getSheetByName(CONFIG.SHEETS.NOTIFY_LOG);
  if (!notifySheet) {
    notifySheet = ss.insertSheet(CONFIG.SHEETS.NOTIFY_LOG);
    notifySheet.appendRow(NOTIFY_LOG_HEADERS);
    notifySheet.setFrozenRows(1);
    notifySheet.getRange(1, 1, 1, NOTIFY_LOG_HEADERS.length).setFontWeight('bold');
  }
}

/**
 * Public entry point (run from the editor on a brand-new install). Once the Roles sheet exists it
 * is restricted to Admins and the spreadsheet owner.
 */
function initializeDatabase() {
  const rolesExists = !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.ROLES);
  if (rolesExists) requireSetupAccess_();
  initializeDatabase_();
}

function ensureDatabaseReady_() {
  const SCHEMA_VERSION = 'v3';
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('WFM_SCHEMA_READY') === SCHEMA_VERSION) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return; // someone else is initializing right now
  try {
    if (props.getProperty('WFM_SCHEMA_READY') === SCHEMA_VERSION) return;
    initializeDatabase_();
    props.setProperty('WFM_SCHEMA_READY', SCHEMA_VERSION);
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// BOOTSTRAP PAYLOAD
// ==========================================

function getInitialAppData() {
  ensureDatabaseReady_();

  const userEmail = currentUserEmail_();
  const directory = getRolesDirectory_();
  const userRole = userEmail ? directory.byEmail[userEmail] : null;

  if (!userRole) {
    return {
      authorized: false,
      userEmail: userEmail || 'Unidentified Google Account'
    };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const mode = getAuthMode_();
  // Through the backend API the front app sends email and keeps My To-Do as the signed-in person.
  const apiMode = (typeof API_REQUEST_EMAIL_ !== 'undefined' && !!API_REQUEST_EMAIL_);

  return {
    authorized: true,
    user: { email: userEmail, role: userRole },
    authorizedUsers: directory.list,
    shifts: CONFIG.SHIFTS,
    todoStatuses: CONFIG.TODO_STATUSES,
    ticketTypes: CONFIG.TICKET_TYPES,
    ticketStatuses: CONFIG.TICKET_STATUSES,
    today: today,
    timezone: ss.getSpreadsheetTimeZone(),
    webAppUrl: getWebAppUrl_(),
    initialTodoSyncTime: Number(props.getProperty('WFM_MUTATION_TODO') || 0),
    initialTicketSyncTime: Number(props.getProperty('WFM_MUTATION_TICKETS') || 0),
    executesAsUser: apiMode || mode.executesAsUser,
    features: { dayBundle: true, multiAssign: true, mentions: true, personalTodo: apiMode || mode.executesAsUser },
    permissions: apiMode ? { complete: true, missing: [], url: '' } : getPermissionStatus_()
  };
}

// ==========================================
// FAST ATTACHMENT STORAGE & STREAMING
// ==========================================

function getCachedAttachmentsFolder() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty('WFM_ATTACHMENTS_FOLDER_ID');

  if (cachedId) {
    try {
      const folder = DriveApp.getFolderById(cachedId);
      if (!folder.isTrashed()) return folder;
    } catch (e) {
      // Not "the folder is not shared with you": the person did not grant the app Google Drive access.
      if (isPermissionError_(e)) throw new Error(permissionErrorMessage_('Google Drive'));
    }
  }

  // Only an Admin (or the spreadsheet owner) may look for or create the shared folder. A normal
  // user must never create a private copy in their own Drive: that would scatter attachments.
  let canProvision = false;
  try { canProvision = getCurrentUser_().isAdmin || isSpreadsheetOwner_(); } catch (e) {}
  if (!canProvision) {
    throw new Error('The attachments folder is not shared with you yet. Ask an Admin to run setup (shareWithTeam).');
  }

  const folders = DriveApp.getFoldersByName(CONFIG.DRIVE_FOLDER);
  let folder = null;
  while (folders.hasNext()) {
    const candidate = folders.next();
    if (!candidate.isTrashed()) { folder = candidate; break; }
  }

  // New folders are private to the team (shared by shareWithTeam), not "anyone with the link".
  if (!folder) folder = DriveApp.createFolder(CONFIG.DRIVE_FOLDER);

  props.setProperty('WFM_ATTACHMENTS_FOLDER_ID', folder.getId());
  return folder;
}

/** True when the file lives in the attachments folder (id match, or a folder with the app's name). */
function isInAttachmentsFolder_(file) {
  const configuredId = PropertiesService.getScriptProperties().getProperty('WFM_ATTACHMENTS_FOLDER_ID');
  const parents = file.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() === configuredId || parent.getName() === CONFIG.DRIVE_FOLDER) return true;
  }
  return false;
}

function trashUploaded_(records) {
  (records || []).forEach(function (rec) {
    try { DriveApp.getFileById(rec.id).setTrashed(true); } catch (e) {}
  });
}

function saveAttachmentsToDrive(attachmentsArray) {
  requireRegistered_();
  if (!attachmentsArray || !Array.isArray(attachmentsArray) || attachmentsArray.length === 0) {
    return [];
  }

  // Same limits the browser shows, now also enforced here (the browser is not a security boundary).
  if (attachmentsArray.length > 5) throw new Error('Maximum 5 files per submission.');
  let totalBytes = 0;
  attachmentsArray.forEach(function (item) {
    const approxBytes = Math.floor(String((item && item.base64) || '').length * 0.75);
    if (approxBytes > 8 * 1024 * 1024) throw new Error('"' + String((item && item.name) || 'file') + '" is larger than 8 MB.');
    totalBytes += approxBytes;
  });
  if (totalBytes > 20 * 1024 * 1024) throw new Error('Total attachment size exceeds 20 MB.');

  const folder = getCachedAttachmentsFolder();
  const uploadedRecords = [];

  for (let i = 0; i < attachmentsArray.length; i++) {
    const item = attachmentsArray[i];
    if (!item.base64 || !item.name) continue;

    try {
      const decoded = Utilities.base64Decode(item.base64);
      const safeName = String(item.name).replace(/[\\/:*?"<>|]/g, '_').substring(0, 120);
      const blob = Utilities.newBlob(decoded, item.mimeType || 'application/octet-stream', safeName);
      const file = folder.createFile(blob);
      const fileId = file.getId();

      uploadedRecords.push({
        id: fileId,
        name: safeName,
        url: 'https://drive.google.com/uc?export=download&id=' + fileId,
        previewUrl: file.getUrl(),
        size: sanitizeAttachmentSize_(item.size),
        mimeType: item.mimeType || ''
      });
    } catch (err) {
      uploadedRecords.forEach(function (rec) {
        try { DriveApp.getFileById(rec.id).setTrashed(true); } catch (e2) {}
      });
      throw new Error('Attachment "' + item.name + '" could not be saved: ' + err.message);
    }
  }

  return uploadedRecords;
}

function getAttachmentFileBlob(fileIdOrUrl) {
  requireRegistered_();
  try {
    let fileId = String(fileIdOrUrl || '').trim();
    if (fileId.indexOf('http') !== -1 || fileId.length > 35) {
      const idMatch = fileId.match(/[?&]id=([-\w]{25,})/) || fileId.match(/\/d\/([-\w]{25,})/);
      if (idMatch) {
        fileId = idMatch[1];
      } else {
        const rawMatch = fileId.match(/[-\w]{25,}/);
        if (rawMatch) fileId = rawMatch[0];
      }
    }

    const file = DriveApp.getFileById(fileId);
    if (!isInAttachmentsFolder_(file)) {
      return { success: false, error: 'This file is not an app attachment.' };
    }
    const size = file.getSize();
    if (size > 20 * 1024 * 1024) {
      return {
        success: false,
        error: 'This file is ' + (size / 1048576).toFixed(1) + ' MB, too large to stream in-app. Use direct link.',
        driveUrl: file.getUrl()
      };
    }

    const blob = file.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());

    return {
      success: true,
      name: file.getName(),
      mimeType: blob.getContentType() || 'application/octet-stream',
      base64: base64
    };
  } catch (err) {
    if (isPermissionError_(err)) return { success: false, error: permissionErrorMessage_('Google Drive'), needsPermission: true };
    return { success: false, error: err.message };
  }
}

// ==========================================
// TO-DO LIST & SHIFT CLOSURE MODULE
// ==========================================

function normalizeSheetDate_(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  return String(value || '').trim();
}

function normalizeIsoOrDate_(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  return String(val).trim();
}

function getShiftClosureInfo_(ss, tz, dateStr, shift) {
  const closuresSheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
  if (!closuresSheet) return null;

  const lastRow = closuresSheet.getLastRow();
  if (lastRow < 2) return null;

  const data = closuresSheet.getRange(2, 1, lastRow - 1, 9).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    const rowDate = normalizeSheetDate_(data[i][0], tz);
    const rowShift = String(data[i][1]).trim();
    if (rowDate === dateStr && rowShift === shift) {
      const isLocked = (data[i][8] === true || String(data[i][8]).toLowerCase() === 'true');
      return {
        isLocked: isLocked,
        closedAt: normalizeIsoOrDate_(data[i][2]),
        closedBy: String(data[i][3] || '').trim(),
        totalTasks: Number(data[i][4] || 0),
        completedCount: Number(data[i][5] || 0),
        cancelledCount: Number(data[i][6] || 0),
        notes: String(data[i][7] || '').trim()
      };
    }
  }
  return null;
}

function isMasterTask_(shift, taskName) {
  return getMasterTasks_().some(function (m) { return m.shift === shift && m.name === taskName; });
}

/**
 * Validates and normalizes one task field. Enforces on the SERVER the rules the browser already showed.
 * - status: must be Pending / Completed / Cancelled
 * - assignedTo: one or more people. RTM may only add or remove THEMSELVES; Manager/Admin may set anyone.
 * - receivedBy: one person. RTM may only set themselves, clear it, or leave it unchanged.
 * Legacy values (a person no longer in Roles) can stay; they just cannot be newly added.
 */
/**
 * R-1 hardening: attachment records are rebuilt from known fields only, so a client cannot store
 * markup or foreign links in the Attachments cells. Real records look like
 * {id, name, url, previewUrl, size:"77.6 KB", mimeType}. Anything unexpected is dropped or reset.
 * Names are stored as typed (the pages escape them when shown); links must point at Google Drive or Docs.
 */
function sanitizeAttachmentSize_(size) {
  const text = String(size === undefined || size === null ? '' : size).trim();
  return /^[0-9][0-9.,]{0,9} ?(B|KB|MB|GB)$/.test(text) ? text : 'File';
}

function sanitizeAttachmentList_(list) {
  const out = [];
  (list || []).forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    const id = String(a.id || '').trim();
    if (!/^[-\w]{20,60}$/.test(id)) return;
    const name = String(a.name || 'file').replace(/[\u0000-\u001f]/g, '_').substring(0, 200) || 'file';
    out.push({
      id: id,
      name: name,
      url: 'https://drive.google.com/uc?export=download&id=' + id,
      previewUrl: /^https:\/\/(drive|docs)\.google\.com\/[\w\-\/.?=&%]{1,300}$/.test(String(a.previewUrl || ''))
        ? String(a.previewUrl)
        : 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk',
      size: sanitizeAttachmentSize_(a.size),
      mimeType: /^[\w.+-]{1,60}\/[\w.+-]{1,100}$/.test(String(a.mimeType || '')) ? String(a.mimeType) : ''
    });
  });
  return out;
}

function normalizeTaskFieldValue_(fieldName, value, previous, user) {
  if (fieldName === 'status') {
    const status = String(value || '').trim();
    if (CONFIG.TODO_STATUSES.indexOf(status) === -1) throw new Error('Invalid status.');
    return status;
  }

  if (fieldName === 'assignedTo') {
    const directory = getRolesDirectory_();
    const next = normalizeEmailList_(value);
    const before = normalizeEmailList_(previous);
    next.forEach(function (email) {
      if (!directory.byEmail[email] && before.indexOf(email) === -1) {
        throw new Error('"' + email + '" is not in the Roles directory.');
      }
    });
    if (!user.isElevated) {
      const added = next.filter(function (e) { return before.indexOf(e) === -1; });
      const removed = before.filter(function (e) { return next.indexOf(e) === -1; });
      const onlySelf = added.concat(removed).every(function (e) { return e === user.email; });
      if (!onlySelf) throw new Error('RTM members can only add or remove themselves as an assignee.');
    }
    return next.join(', ');
  }

  if (fieldName === 'receivedBy') {
    const directory = getRolesDirectory_();
    const email = normalizeEmail_(value);
    const before = normalizeEmail_(previous);
    if (email && !directory.byEmail[email] && email !== before) {
      throw new Error('"' + email + '" is not in the Roles directory.');
    }
    if (!user.isElevated && email && email !== user.email && email !== before) {
      throw new Error('RTM members can only set themselves as Received By.');
    }
    return email;
  }

  if (fieldName === 'comment') {
    const text = String(value === undefined || value === null ? '' : value);
    if (text.length > 10000) throw new Error('The comment is too long (max 10,000 characters).');
    return text;
  }

  if (fieldName === 'attachments') {
    const raw = String(value || '');
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { throw new Error('Invalid attachments value.'); }
      if (!Array.isArray(parsed)) throw new Error('Invalid attachments value.');
      return parsed.length ? JSON.stringify(sanitizeAttachmentList_(parsed)) : '';
    }
    return raw;
  }

  throw new Error('Invalid task field.');
}

function updateTaskField(dateStr, shift, taskName, fieldName, value) {
  const user = requireRegistered_();

  const fieldColumnMap = {
    'assignedTo': CONFIG.TODO_COLS.ASSIGNED,
    'receivedBy': CONFIG.TODO_COLS.RECEIVED,
    'status': CONFIG.TODO_COLS.STATUS,
    'comment': CONFIG.TODO_COLS.COMMENT,
    'attachments': CONFIG.TODO_COLS.ATTACHMENTS
  };

  const targetCol = fieldColumnMap[fieldName];
  if (!targetCol) throw new Error('Invalid task field.');

  dateStr = assertDateStr_(dateStr);
  shift = assertShift_(shift);
  taskName = String(taskName || '').trim();
  if (!taskName) throw new Error('Task name is required.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('The task list is busy. Please retry in a moment.');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();

    const closure = getShiftClosureInfo_(ss, tz, dateStr, shift);
    if (closure && closure.isLocked && !user.isElevated) {
      throw new Error('This shift was closed by ' + closure.closedBy + ' and is locked against modifications.');
    }

    const todoSheet = ss.getSheetByName(CONFIG.SHEETS.TODO_LIST);
    const targetRowIndex = findTodoRow_(todoSheet, tz, dateStr, shift, taskName);

    if (targetRowIndex < 2 && !isMasterTask_(shift, taskName)) {
      throw new Error('Unknown task for this shift.');
    }

    const previous = (targetRowIndex > 1 && (fieldName === 'assignedTo' || fieldName === 'receivedBy'))
      ? todoSheet.getRange(targetRowIndex, targetCol).getValue()
      : '';
    const stored = normalizeTaskFieldValue_(fieldName, value, previous, user);

    if (targetRowIndex > 1) {
      todoSheet.getRange(targetRowIndex, targetCol).setValue(stored);
      notifyMutation_('todo');
      return { success: true, rowIndex: targetRowIndex, value: stored };
    }

    const newRow = [
      dateStr,
      taskName,
      shift,
      fieldName === 'assignedTo' ? stored : '',
      fieldName === 'receivedBy' ? stored : '',
      fieldName === 'status' ? stored : 'Pending',
      fieldName === 'comment' ? stored : '',
      fieldName === 'attachments' ? stored : ''
    ];
    todoSheet.appendRow(newRow);
    notifyMutation_('todo');
    return { success: true, rowIndex: todoSheet.getLastRow(), value: stored };
  } finally {
    lock.releaseLock();
  }
}

function updateTodoCommentWithFiles(dateStr, shift, taskName, commentText, rawFiles, options) {
  const user = requireRegistered_();

  dateStr = assertDateStr_(dateStr);
  shift = assertShift_(shift);
  taskName = String(taskName || '').trim();
  if (!taskName) throw new Error('Task name is required.');
  commentText = String(commentText === undefined || commentText === null ? '' : commentText).trim();
  if (commentText.length > 10000) throw new Error('The comment is too long (max 10,000 characters).');
  const notifyEnabled = !(options && options.notifyMentions === false);

  const uploaded = saveAttachmentsToDrive(rawFiles || []);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    trashUploaded_(uploaded);
    throw new Error('The task list is busy. Please retry in a moment.');
  }

  let response;
  let oldComment = '';
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();

    const closure = getShiftClosureInfo_(ss, tz, dateStr, shift);
    if (closure && closure.isLocked && !user.isElevated) {
      throw new Error('This shift was closed by ' + closure.closedBy + ' and is locked against modifications.');
    }

    const todoSheet = ss.getSheetByName(CONFIG.SHEETS.TODO_LIST);
    const rowIndex = findTodoRow_(todoSheet, tz, dateStr, shift, taskName);

    if (rowIndex > 1) {
      oldComment = String(todoSheet.getRange(rowIndex, CONFIG.TODO_COLS.COMMENT).getValue() || '');
      if (uploaded.length > 0) {
        let existing = [];
        try {
          const currentJson = todoSheet.getRange(rowIndex, CONFIG.TODO_COLS.ATTACHMENTS).getValue();
          existing = currentJson ? JSON.parse(currentJson) : [];
        } catch (e) {
          existing = [];
        }
        const combined = existing.concat(uploaded);
        todoSheet.getRange(rowIndex, CONFIG.TODO_COLS.COMMENT, 1, 2)
                 .setValues([[commentText, JSON.stringify(combined)]]);
      } else {
        todoSheet.getRange(rowIndex, CONFIG.TODO_COLS.COMMENT).setValue(commentText);
      }
      notifyMutation_('todo');
      response = { success: true, rowIndex: rowIndex, attachments: uploaded };
    } else {
      if (!isMasterTask_(shift, taskName)) throw new Error('Unknown task for this shift.');
      todoSheet.appendRow([
        dateStr, taskName, shift, '', '', 'Pending',
        commentText,
        uploaded.length > 0 ? JSON.stringify(uploaded) : ''
      ]);
      notifyMutation_('todo');
      response = { success: true, rowIndex: todoSheet.getLastRow(), attachments: uploaded };
    }
  } catch (err) {
    trashUploaded_(uploaded);
    throw err;
  } finally {
    lock.releaseLock();
  }

  // Email AFTER the lock is released so a slow mail call never blocks other people's edits.
  response.mentions = notifyCommentMentions_(user, {
    enabled: notifyEnabled,
    oldComment: oldComment,
    newComment: commentText,
    date: dateStr,
    shift: shift,
    taskName: taskName
  });
  return response;
}

function closeShift(dateStr, shift, handoverNotes) {
  dateStr = assertDateStr_(dateStr);
  shift = assertShift_(shift);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('The system is busy right now. Please try again in a moment.');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const userEmail = currentUserEmail_();
    const userRole = getRolesDirectory_().byEmail[userEmail];
    if (!userRole) throw new Error('Unauthorized account.');

    const existingClosure = getShiftClosureInfo_(ss, tz, dateStr, shift);
    if (existingClosure && existingClosure.isLocked) {
      throw new Error('This shift is already closed and locked.');
    }

    // Fresh read inside the lock (never the cache) so the counts are exactly what is on the sheet.
    const taskData = buildDayBundle_(ss, tz, dateStr).shifts[shift];
    const tasks = taskData.tasks;
    if (!tasks || tasks.length === 0) {
      throw new Error('No tasks found for this shift.');
    }

    const pendingTasks = tasks.filter(t => t.status === 'Pending');
    if (pendingTasks.length > 0) {
      throw new Error('Cannot close shift: ' + pendingTasks.length + ' task(s) are still Pending.');
    }

    const completedCount = tasks.filter(t => t.status === 'Completed').length;
    const cancelledCount = tasks.filter(t => t.status === 'Cancelled').length;

    let closuresSheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
    if (!closuresSheet) {
      initializeDatabase();
      closuresSheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
    }

    const nowIso = new Date().toISOString();
    closuresSheet.appendRow([
      dateStr,
      shift,
      nowIso,
      userEmail,
      tasks.length,
      completedCount,
      cancelledCount,
      String(handoverNotes || '').trim(),
      true
    ]);

    notifyMutation_('todo');

    return {
      success: true,
      closure: {
        isLocked: true,
        closedAt: nowIso,
        closedBy: userEmail,
        totalTasks: tasks.length,
        completedCount: completedCount,
        cancelledCount: cancelledCount,
        notes: String(handoverNotes || '').trim()
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function reopenShift(dateStr, shift, unlockReason) {
  dateStr = assertDateStr_(dateStr);
  shift = assertShift_(shift);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('The system is busy right now. Please try again in a moment.');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss.getSpreadsheetTimeZone();
    const userEmail = currentUserEmail_();
    const userRole = getRolesDirectory_().byEmail[userEmail];
    if (userRole !== 'Manager' && userRole !== 'Admin') {
      throw new Error('Unauthorized: Only Managers and Admins can unlock a closed shift.');
    }

    const closuresSheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
    if (!closuresSheet) throw new Error('Shift Closures sheet not found.');

    const lastRow = closuresSheet.getLastRow();
    if (lastRow < 2) throw new Error('No closure record found.');

    const data = closuresSheet.getRange(2, 1, lastRow - 1, 9).getValues();
    let targetRow = -1;
    for (let i = data.length - 1; i >= 0; i--) {
      const rowDate = normalizeSheetDate_(data[i][0], tz);
      const rowShift = String(data[i][1]).trim();
      const isLocked = (data[i][8] === true || String(data[i][8]).toLowerCase() === 'true');
      if (rowDate === dateStr && rowShift === shift && isLocked) {
        targetRow = i + 2;
        break;
      }
    }

    if (targetRow === -1) {
      throw new Error('No active lock found for this shift.');
    }

    closuresSheet.getRange(targetRow, 9).setValue(false);
    const currentNotes = String(closuresSheet.getRange(targetRow, 8).getValue() || '');
    const updatedNotes = currentNotes + (currentNotes ? '\n' : '') + `[Unlocked by ${userEmail} at ${new Date().toISOString()}: ${unlockReason || 'No reason provided'}]`;
    closuresSheet.getRange(targetRow, 8).setValue(updatedNotes);

    notifyMutation_('todo');

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// TICKET SUBSYSTEM: moved to Tickets.gs (getTickets, createTicket, updateTicket,
// addTicketComment, getTicketActivity).
// ==========================================

// ==========================================
// NOTIFICATIONS
// ==========================================

// ==========================================
// EXPORT TO CSV
// ==========================================

function exportRawSheetToCsv(sourceType) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const currentUserEmail = currentUserEmail_();

  const userRole = getRolesDirectory_().byEmail[currentUserEmail];

  if (userRole !== 'Admin' && userRole !== 'Manager') {
    throw new Error('Unauthorized: Exporting raw data is restricted to Admin and Manager roles only.');
  }

  const SOURCES = {
    'tickets': { sheet: CONFIG.SHEETS.TICKETS, prefix: 'Tickets_Raw' },
    'ticket_activity': { sheet: 'Ticket Activity', prefix: 'TicketActivity_Raw' },
    'todo': { sheet: CONFIG.SHEETS.TODO_LIST, prefix: 'TodoList_Raw' },
    'master_tasks': { sheet: CONFIG.SHEETS.DAILY_TASKS, prefix: 'DailyTasks_Master_Raw' },
    'shift_closures': { sheet: CONFIG.SHEETS.SHIFT_CLOSURES, prefix: 'ShiftClosures_Raw' }
  };

  const source = SOURCES[sourceType];
  if (!source) throw new Error('Invalid export source specified.');

  const sheet = ss.getSheetByName(source.sheet);
  if (!sheet) throw new Error('Data sheet "' + source.sheet + '" not found.');

  const data = sheet.getDataRange().getValues();
  if (!data || data.length === 0) throw new Error('Sheet "' + source.sheet + '" is empty.');

  const csvLines = [];
  for (let i = 0; i < data.length; i++) {
    const escapedRow = data[i].map(function (cell) {
      if (cell === null || cell === undefined) return '""';
      let cellStr = (cell instanceof Date)
        ? Utilities.formatDate(cell, tz, 'yyyy-MM-dd HH:mm:ss')
        : String(cell);
      if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(cellStr)) cellStr = "'" + cellStr;
      if (cellStr.search(/("|,|\n|\r)/g) >= 0) {
        cellStr = '"' + cellStr.replace(/"/g, '""') + '"';
      }
      return cellStr;
    });
    csvLines.push(escapedRow.join(','));
  }

  const timestamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');

  return {
    success: true,
    filename: 'WFM_' + source.prefix + '_' + timestamp + '.csv',
    rowCount: data.length,
    csvData: csvLines.join('\r\n')
  };
}

// ==========================================
// MAINTENANCE
// ==========================================

function repairDuplicateTodoRows(applyChanges) {
  requireSetupAccess_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.TODO_LIST);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { duplicates: 0, message: 'Todo List is empty.' };

  const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  const seen = {};
  const duplicates = [];

  const filledCount = function (row) {
    return [row[3], row[4], row[5], row[6], row[7]]
      .filter(function (v) { return String(v || '').trim(); }).length;
  };

  for (let i = 0; i < data.length; i++) {
    const dateStr = normalizeSheetDate_(data[i][0], tz);
    const taskName = String(data[i][1]).trim();
    if (!dateStr || !taskName) continue;

    const key = dateStr + '||' + String(data[i][2]).trim() + '||' + taskName;

    if (seen[key] === undefined) {
      seen[key] = i;
    } else {
      const keptIndex = seen[key];
      if (filledCount(data[i]) > filledCount(data[keptIndex])) {
        duplicates.push({ row: keptIndex + 2, key: key });
        seen[key] = i;
      } else {
        duplicates.push({ row: i + 2, key: key });
      }
    }
  }

  if (applyChanges === true && duplicates.length > 0) {
    const uniqueRows = Array.from(new Set(duplicates.map(function (d) { return d.row; })));
    uniqueRows
      .sort(function (a, b) { return b - a; })
      .forEach(function (rowIndex) { sheet.deleteRow(rowIndex); });
  }

  const result = {
    duplicates: duplicates.length,
    rows: duplicates,
    applied: (applyChanges === true),
    message: duplicates.length === 0
      ? 'No duplicate Todo rows found.'
      : duplicates.length + ' duplicate row(s) ' +
        (applyChanges === true ? 'removed.' : 'found. Review the list, then run repairDuplicateTodoRows(true).')
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}