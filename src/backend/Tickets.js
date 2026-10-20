/**
 * Tickets.gs - ticket subsystem (moved out of Code.gs and extended, October 2026).
 *
 * Data
 * - Sheet "Tickets": columns A-J are unchanged (Created At = the ticket's key, Type, Assigned To,
 *   Assigned By, Description, CC, Status, Updated At, Is Public, Attachments). ensureTicketSchema_()
 *   adds K-O once: Ticket No, Priority, Due Date, Updated By, Comments.
 * - Sheet "Ticket Activity": append-only history and comments, one row per event
 *   (Timestamp, Ticket Key, Ticket No, Actor, Action, Details, Meta JSON).
 *
 * Who may do what (owner decisions, 2026-10-07; Operations may create since 2026-10-09)
 * - view    : Manager/Admin see every ticket; everyone else sees public tickets and tickets they are
 *             assigned to, created, or are CC'd on.
 * - create  : every registered user, including Operations.
 * - comment : anyone who can view the ticket (not Operations).
 * - status  : the assignees (everyone, on a ticket assigned to "All Users"), the creator, Manager/Admin.
 *             CC'd people can read and comment but not change the status.
 * - edit    : description, type, priority, due date: the creator and Manager/Admin.
 * - assign  : assignees, CC and public visibility: Manager/Admin.
 * - The Operations role can view (same rule as RTM) and create tickets. It cannot comment, change the
 *   status, edit or reassign, not even on a ticket it created itself.
 *
 * Every write takes the script lock, writes the whole row once, appends to Ticket Activity and bumps
 * the tickets mutation clock. Drive uploads and emails happen OUTSIDE the lock.
 */

const TICKET_SCHEMA_VERSION = 't2';
const TICKET_SCHEMA_PROP = 'WFM_TICKET_SCHEMA';
const TICKET_ACTIVITY_SHEET = 'Ticket Activity';
const TICKET_ACTIVITY_HEADERS = ['Timestamp', 'Ticket Key', 'Ticket No', 'Actor', 'Action', 'Details', 'Meta'];
const TICKET_EXTRA_HEADERS = ['Ticket No', 'Priority', 'Due Date', 'Updated By', 'Comments'];
const TICKET_WIDTH = 15;
const TICKET_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const TICKET_READONLY_ROLES = ['Operations'];
const TICKET_MAX_COMMENT = 10000;
const TICKET_MAX_DESCRIPTION = 20000;
const TICKET_MAX_EMAIL_RECIPIENTS = 25;
// 0-based positions inside a row array (the sheet columns are these + 1).
const TCOL = {
  CREATED: 0, TYPE: 1, ASSIGNED_TO: 2, ASSIGNED_BY: 3, DESC: 4, CC: 5, STATUS: 6, UPDATED: 7,
  PUBLIC: 8, ATTACH: 9, NO: 10, PRIORITY: 11, DUE: 12, UPDATED_BY: 13, COMMENTS: 14
};

// ==========================================
// SCHEMA
// ==========================================

/**
 * Adds columns K-O and the Ticket Activity sheet once, and numbers existing tickets in creation order.
 * strict=false (read path): if another person holds the lock, return false and read what exists.
 */
function ensureTicketSchema_(ss, strict) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(TICKET_SCHEMA_PROP) === TICKET_SCHEMA_VERSION) return true;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    if (strict === false) return false;
    throw new Error('The system is busy right now. Please try again in a moment.');
  }
  try {
    if (props.getProperty(TICKET_SCHEMA_PROP) === TICKET_SCHEMA_VERSION) return true;
    migrateTicketSchema_(ss);
    props.setProperty(TICKET_SCHEMA_PROP, TICKET_SCHEMA_VERSION);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function migrateTicketSchema_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
  if (!sheet) {
    initializeDatabase_();
    sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
  }

  // Headers K-O. Never overwrite a column someone is already using for something else.
  const header = sheet.getRange(1, 11, 1, TICKET_EXTRA_HEADERS.length).getValues()[0];
  header.forEach(function (value, i) {
    const text = String(value || '').trim();
    if (text && text !== TICKET_EXTRA_HEADERS[i]) {
      throw new Error('The Tickets sheet already uses column ' + String.fromCharCode(75 + i) + ' ("' + text +
        '"). Move that column to the right of column O, then reload the app.');
    }
  });
  sheet.getRange(1, 11, 1, TICKET_EXTRA_HEADERS.length).setValues([TICKET_EXTRA_HEADERS]).setFontWeight('bold');
  try { sheet.getRange('M2:M').setNumberFormat('@'); } catch (e) {}   // due dates stay plain text

  // Number existing tickets in the order they were created.
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const created = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const numbers = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
    let max = 0;
    numbers.forEach(function (r) { const n = Number(r[0]); if (n > max) max = n; });
    const missing = [];
    for (let i = 0; i < created.length; i++) {
      if (!created[i][0]) continue;
      if (!(Number(numbers[i][0]) > 0)) missing.push({ i: i, key: normalizeIsoOrDate_(created[i][0]) });
    }
    if (missing.length) {
      missing.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : a.i - b.i); });
      missing.forEach(function (m) { numbers[m.i][0] = ++max; });
      sheet.getRange(2, 11, lastRow - 1, 1).setValues(numbers);
    }
  }

  getTicketActivitySheet_(ss);
}

function getTicketActivitySheet_(ss) {
  let sheet = ss.getSheetByName(TICKET_ACTIVITY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TICKET_ACTIVITY_SHEET);
    sheet.getRange(1, 1, 1, TICKET_ACTIVITY_HEADERS.length).setValues([TICKET_ACTIVITY_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    try { sheet.getRange('A2:C').setNumberFormat('@'); } catch (e) {}   // keys and timestamps stay text
  }
  return sheet;
}

// ==========================================
// SMALL HELPERS
// ==========================================

/** Text for a sheet cell. A leading = + - @ would otherwise be read by Sheets as a formula. */
function ticketCellText_(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function formatTicketNo_(n) {
  const num = Number(n) || 0;
  if (!num) return '';
  const s = String(num);
  return 'T-' + (s.length < 4 ? '0000'.substring(s.length) + s : s);
}

function normalizeTicketPriority_(value, strict) {
  const v = String(value || '').trim();
  if (!v) return 'Normal';
  for (let i = 0; i < TICKET_PRIORITIES.length; i++) {
    if (TICKET_PRIORITIES[i].toLowerCase() === v.toLowerCase()) return TICKET_PRIORITIES[i];
  }
  if (strict) throw new Error('Invalid priority.');
  return 'Normal';
}

/** '' or a valid yyyy-MM-dd. Sheets may hand back a Date for older or hand-typed cells. */
function readTicketDue_(value, tz) {
  if (!value) return '';
  const s = (value instanceof Date) ? Utilities.formatDate(value, tz, 'yyyy-MM-dd') : String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function isTicketPublic_(row) {
  const flag = row[TCOL.PUBLIC];
  return flag === true || String(flag).toLowerCase() === 'true' ||
    String(row[TCOL.ASSIGNED_TO] || '').toLowerCase().trim() === 'all users';
}

function parseTicketAttachments_(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function padTicketRow_(row) {
  const out = (row || []).slice(0, TICKET_WIDTH);
  while (out.length < TICKET_WIDTH) out.push('');
  return out;
}

function isTicketReadOnlyRole_(user) {
  return TICKET_READONLY_ROLES.indexOf(String(user.role || '')) !== -1;
}

function requireTicketWriter_(user) {
  if (isTicketReadOnlyRole_(user)) {
    throw new Error('Your role (' + user.role + ') can view and create tickets but not change them.');
  }
  return user;
}

/** What this user may do with this ticket row. */
function ticketAccess_(row, user) {
  const assignedRaw = String(row[TCOL.ASSIGNED_TO] || '').trim();
  const allUsers = assignedRaw.toLowerCase() === 'all users';
  const isPublic = isTicketPublic_(row);
  const assignees = allUsers ? [] : normalizeEmailList_(assignedRaw);
  const creator = normalizeEmail_(row[TCOL.ASSIGNED_BY]);
  const cc = normalizeEmailList_(row[TCOL.CC]);
  const me = user.email;

  const isAssignee = allUsers || assignees.indexOf(me) !== -1;
  const isCreator = !!me && me === creator;
  const isCc = cc.indexOf(me) !== -1;
  const readOnly = isTicketReadOnlyRole_(user);
  const canView = !!user.isElevated || isPublic || isAssignee || isCreator || isCc;

  return {
    canView: canView,
    isPublic: isPublic,
    allUsers: allUsers,
    assignees: assignees,
    creator: creator,
    cc: cc,
    canComment: canView && !readOnly,
    canStatus: canView && !readOnly && (!!user.isElevated || isAssignee || isCreator),
    canEdit: canView && !readOnly && (!!user.isElevated || isCreator),
    canAssign: canView && !readOnly && !!user.isElevated
  };
}

/** The shape the page uses. Keeps every field the old page read (createdAt, ticketType, ...). */
function ticketToClient_(row, access, tz) {
  const key = normalizeIsoOrDate_(row[TCOL.CREATED]);
  return {
    key: key,
    createdAt: key,
    no: Number(row[TCOL.NO]) || 0,
    label: formatTicketNo_(row[TCOL.NO]),
    ticketType: String(row[TCOL.TYPE] || 'Task'),
    assignedTo: String(row[TCOL.ASSIGNED_TO] || '').trim(),
    assignedBy: String(row[TCOL.ASSIGNED_BY] || '').trim(),
    description: String(row[TCOL.DESC] || ''),
    cc: String(row[TCOL.CC] || ''),
    status: String(row[TCOL.STATUS] || 'Open'),
    updatedAt: normalizeIsoOrDate_(row[TCOL.UPDATED] || row[TCOL.CREATED]),
    updatedBy: String(row[TCOL.UPDATED_BY] || row[TCOL.ASSIGNED_BY] || '').trim(),
    isPublic: access.isPublic,
    attachments: parseTicketAttachments_(row[TCOL.ATTACH]),
    priority: normalizeTicketPriority_(row[TCOL.PRIORITY], false),
    dueDate: readTicketDue_(row[TCOL.DUE], tz),
    commentCount: Number(row[TCOL.COMMENTS]) || 0,
    perms: {
      comment: access.canComment,
      status: access.canStatus,
      edit: access.canEdit,
      assign: access.canAssign
    }
  };
}

/** Row number (2..) of the ticket whose Created At equals key, or -1. Reads column A only. */
function findTicketRow_(sheet, key) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const target = String(key || '').trim();
  const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) {          // recent tickets are at the bottom
    if (col[i][0] && normalizeIsoOrDate_(col[i][0]) === target) return i + 2;
  }
  return -1;
}

function readTicketRow_(sheet, rowIndex) {
  const width = Math.max(10, Math.min(TICKET_WIDTH, sheet.getLastColumn()));
  return padTicketRow_(sheet.getRange(rowIndex, 1, 1, width).getValues()[0]);
}

function nextTicketNo_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const values = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
  let max = 0;
  values.forEach(function (r) { const n = Number(r[0]); if (n > max) max = n; });
  return max + 1;
}

/** Key for a new ticket: an ISO timestamp, nudged by 1 ms if the last ticket has the same one. */
function newTicketKey_(sheet) {
  let t = Date.now();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const last = normalizeIsoOrDate_(sheet.getRange(lastRow, 1).getValue());
    const lastMs = Date.parse(last);
    if (!isNaN(lastMs) && lastMs >= t) t = lastMs + 1;
  }
  return new Date(t).toISOString();
}

function appendTicketActivity_(ss, entries) {
  if (!entries || !entries.length) return;
  const sheet = getTicketActivitySheet_(ss);
  const rows = entries.map(function (e) {
    return [
      e.at,
      e.key,
      e.no || '',
      e.actor,
      e.action,
      ticketCellText_(String(e.details || '').substring(0, 45000)),
      ticketCellText_(JSON.stringify(e.meta || {}).substring(0, 45000))
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, TICKET_ACTIVITY_HEADERS.length).setValues(rows);
}

function sameEmailSet_(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.slice().sort().join(','), sb = b.slice().sort().join(',');
  return sa === sb;
}

// ==========================================
// READ
// ==========================================

function getTickets() {
  const user = requireRegistered_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTicketSchema_(ss, false);
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const width = Math.max(10, Math.min(TICKET_WIDTH, sheet.getLastColumn()));
  const data = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  const visible = [];
  for (let i = 0; i < data.length; i++) {
    const row = padTicketRow_(data[i]);
    if (!row[TCOL.CREATED]) continue;
    const access = ticketAccess_(row, user);
    if (!access.canView) continue;
    visible.push(ticketToClient_(row, access, tz));
  }
  return visible.reverse();
}

/** Activity and comments of one ticket, oldest first. */
function getTicketActivity(ticketKey) {
  const user = requireRegistered_();
  const key = String(ticketKey || '').trim();
  if (!key) throw new Error('Ticket not found.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
  const rowIndex = sheet ? findTicketRow_(sheet, key) : -1;
  if (rowIndex < 2) throw new Error('Ticket not found.');
  const row = readTicketRow_(sheet, rowIndex);
  if (!ticketAccess_(row, user).canView) throw new Error('You do not have permission to view this ticket.');

  const entries = readTicketActivity_(ss, key);
  if (!entries.some(function (e) { return e.action === 'created'; })) {
    // Tickets created before the activity log existed.
    entries.unshift({ at: key, actor: String(row[TCOL.ASSIGNED_BY] || ''), action: 'created', details: 'Created this ticket', meta: {} });
  }
  return { key: key, entries: entries };
}

function readTicketActivity_(ss, key) {
  const sheet = ss.getSheetByName(TICKET_ACTIVITY_SHEET);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const keys = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const hits = [];
  for (let i = 0; i < keys.length; i++) {
    if (normalizeIsoOrDate_(keys[i][0]) === key) hits.push(i + 2);
  }
  if (!hits.length) return [];

  const width = TICKET_ACTIVITY_HEADERS.length;
  let rows = [];
  const first = hits[0], last = hits[hits.length - 1];
  if (last - first < 3000) {
    // One read of the block that holds all of this ticket's rows (they are close together in time).
    const block = sheet.getRange(first, 1, last - first + 1, width).getValues();
    rows = hits.map(function (r) { return block[r - first]; });
  } else {
    rows = hits.map(function (r) { return sheet.getRange(r, 1, 1, width).getValues()[0]; });
  }

  return rows.map(function (r) {
    let meta = {};
    try { meta = r[6] ? JSON.parse(r[6]) : {}; } catch (e) { meta = {}; }
    return {
      at: normalizeIsoOrDate_(r[0]),
      actor: String(r[3] || ''),
      action: String(r[4] || ''),
      details: String(r[5] || ''),
      meta: meta
    };
  });
}

// ==========================================
// CREATE
// ==========================================

function createTicket(ticketInput) {
  // Every registered user may create a ticket, Operations included (owner decision, 2026-10-09).
  // Changing a ticket afterwards stays behind requireTicketWriter_ / ticketAccess_.
  const user = requireRegistered_();
  ticketInput = ticketInput || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTicketSchema_(ss, true);
  const tz = ss.getSpreadsheetTimeZone();
  const directory = getRolesDirectory_();

  const ticketType = CONFIG.TICKET_TYPES.indexOf(ticketInput.ticketType) !== -1 ? ticketInput.ticketType : 'Task';
  const isPublic = (ticketInput.isPublic === true);

  let assignedTo = '';
  if (isPublic) {
    assignedTo = 'All Users';
  } else {
    const assignees = normalizeEmailList_(ticketInput.assignedTo);
    assignees.forEach(function (email) {
      if (!directory.byEmail[email]) throw new Error('"' + email + '" is not in the Roles directory.');
    });
    assignedTo = assignees.join(', ');
  }
  if (!assignedTo) throw new Error('At least one Assignee is required.');

  const assignedLower = normalizeEmailList_(assignedTo);
  const ccList = normalizeEmailList_(ticketInput.cc).filter(function (email) {
    return assignedLower.indexOf(email) === -1;
  });
  ccList.forEach(function (email) {
    if (!directory.byEmail[email]) throw new Error('"' + email + '" is not in the Roles directory.');
  });
  const cc = ccList.join(', ');

  const description = String(ticketInput.description || '').trim();
  if (!description) throw new Error('Description is required.');
  if (description.length > TICKET_MAX_DESCRIPTION) throw new Error('Description is too long (max 20,000 characters).');

  const priority = normalizeTicketPriority_(ticketInput.priority, true);
  const dueDate = ticketInput.dueDate ? assertDateStr_(ticketInput.dueDate) : '';
  const shouldSendEmail = (ticketInput.shouldSendEmail !== false);

  // Upload BEFORE taking the lock so Drive work never blocks other people's writes.
  const uploaded = saveAttachmentsToDrive(ticketInput.rawFiles || []);
  const attachmentsJson = uploaded.length > 0 ? JSON.stringify(uploaded) : '';

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    trashUploaded_(uploaded);
    throw new Error('The system is busy right now. Please try again in a moment.');
  }

  let row;
  try {
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
    const key = newTicketKey_(sheet);
    const no = nextTicketNo_(sheet);
    row = [
      key, ticketType, assignedTo, user.email, ticketCellText_(description),
      cc, 'Open', key, isPublic, attachmentsJson,
      no, priority, dueDate, user.email, 0
    ];
    sheet.appendRow(row);
    row[TCOL.DESC] = description;
    appendTicketActivity_(ss, [{
      at: key, key: key, no: no, actor: user.email, action: 'created',
      details: 'Created this ' + ticketType.toLowerCase(),
      meta: { priority: priority, dueDate: dueDate, assignedTo: assignedTo, cc: cc, attachments: uploaded.length }
    }]);
    notifyMutation_('tickets');
  } catch (err) {
    trashUploaded_(uploaded);
    throw err;
  } finally {
    lock.releaseLock();
  }

  const ticket = ticketToClient_(row, ticketAccess_(row, user), tz);

  // Email AFTER the lock is released, sent from the signed-in user's own account.
  let mail = { sent: false, error: null };
  if (shouldSendEmail) {
    const allUsers = assignedTo === 'All Users';
    const to = allUsers ? directory.list.map(function (u) { return u.email; }) : normalizeEmailList_(assignedTo);
    mail = sendTicketEmail_(user, ticket, {
      kind: 'created',
      to: to,
      cc: allUsers ? [] : ccList,
      headline: (isPublic ? 'Public announcement' : 'Action required') + ': a new ' + ticketType.toLowerCase() + ' has been assigned.',
      body: description,
      includeAttachments: true
    });
  }

  return { success: true, emailDispatched: mail.sent, emailError: mail.error, ticket: ticket };
}

// ==========================================
// UPDATE
// ==========================================

/**
 * updates (all optional): status, description, ticketType, priority, dueDate, assignedTo, cc, isPublic,
 * newRawFiles, notify (default true), base = { field: value the page showed } for conflict checks.
 * Older pages send expectedUpdatedAt instead of base; that still works (whole-ticket check).
 * A field is only checked and written when its value really changes.
 */
function updateTicket(ticketKey, updates) {
  const user = requireTicketWriter_(requireRegistered_());
  updates = updates || {};
  const key = String(ticketKey || '').trim();
  if (!key) throw new Error('Ticket not found in database.');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTicketSchema_(ss, true);
  const tz = ss.getSpreadsheetTimeZone();
  const directory = getRolesDirectory_();
  const notify = updates.notify !== false;

  const uploaded = saveAttachmentsToDrive(Array.isArray(updates.newRawFiles) ? updates.newRawFiles : []);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    trashUploaded_(uploaded);
    throw new Error('The system is busy right now. Please try again in a moment.');
  }

  let row, next, access, nowIso;
  const changes = [];
  const activity = [];
  let addedAssignees = [];
  let statusChange = null;
  try {
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
    const rowIndex = findTicketRow_(sheet, key);
    if (rowIndex < 2) throw new Error('Ticket not found in database.');
    row = readTicketRow_(sheet, rowIndex);
    access = ticketAccess_(row, user);
    if (!access.canView) throw new Error('You do not have permission to access or update this ticket.');

    const base = (updates.base && typeof updates.base === 'object') ? updates.base : null;
    if (!base && updates.expectedUpdatedAt) {
      const currentUpdatedAt = normalizeIsoOrDate_(row[TCOL.UPDATED] || row[TCOL.CREATED]);
      if (currentUpdatedAt && currentUpdatedAt !== String(updates.expectedUpdatedAt).trim()) {
        throw new Error('This ticket was changed by someone else while you had it open. Reopen it to see the latest version.');
      }
    }
    const checkConflict = function (field, label, current) {
      if (!base || !Object.prototype.hasOwnProperty.call(base, field)) return;
      if (String(base[field] === undefined || base[field] === null ? '' : base[field]).trim() !== String(current).trim()) {
        throw new Error('Someone else changed the ' + label + ' of this ticket while you had it open. Reopen it to see the latest version.');
      }
    };

    next = row.slice();
    nowIso = new Date().toISOString();
    const no = Number(row[TCOL.NO]) || '';
    const log = function (action, details, meta) {
      activity.push({ at: nowIso, key: key, no: no, actor: user.email, action: action, details: details, meta: meta || {} });
    };

    // Status
    if (updates.status !== undefined && updates.status !== null) {
      const st = String(updates.status).trim();
      if (CONFIG.TICKET_STATUSES.indexOf(st) === -1) throw new Error('Invalid status.');
      const before = String(row[TCOL.STATUS] || 'Open').trim();
      if (st !== before) {
        if (!access.canStatus) throw new Error('Only the assignees, the creator or a Manager can change the status of this ticket.');
        checkConflict('status', 'status', before);
        next[TCOL.STATUS] = st;
        changes.push('status set to ' + st);
        log('status', before + ' → ' + st, { from: before, to: st });
        statusChange = { from: before, to: st };
      }
    }

    // Description
    if (updates.description !== undefined && updates.description !== null) {
      const text = String(updates.description).trim();
      const before = String(row[TCOL.DESC] || '').trim();
      if (text !== before) {
        if (!access.canEdit) throw new Error('Only the creator or a Manager can edit the description. Add a comment instead.');
        if (!text) throw new Error('Description is required.');
        if (text.length > TICKET_MAX_DESCRIPTION) throw new Error('Description is too long (max 20,000 characters).');
        checkConflict('description', 'description', before);
        next[TCOL.DESC] = text;
        changes.push('description updated');
        log('description', 'Edited the description', { previous: before });
      }
    }

    // Type
    if (updates.ticketType !== undefined && updates.ticketType !== null) {
      const tp = String(updates.ticketType).trim();
      if (CONFIG.TICKET_TYPES.indexOf(tp) === -1) throw new Error('Invalid ticket type.');
      const before = String(row[TCOL.TYPE] || 'Task').trim();
      if (tp !== before) {
        if (!access.canEdit) throw new Error('Only the creator or a Manager can change the type.');
        checkConflict('ticketType', 'type', before);
        next[TCOL.TYPE] = tp;
        changes.push('type set to ' + tp);
        log('type', before + ' → ' + tp, { from: before, to: tp });
      }
    }

    // Priority
    if (updates.priority !== undefined && updates.priority !== null) {
      const pr = normalizeTicketPriority_(updates.priority, true);
      const before = normalizeTicketPriority_(row[TCOL.PRIORITY], false);
      if (pr !== before) {
        if (!access.canEdit) throw new Error('Only the creator or a Manager can change the priority.');
        checkConflict('priority', 'priority', before);
        next[TCOL.PRIORITY] = pr;
        changes.push('priority set to ' + pr);
        log('priority', before + ' → ' + pr, { from: before, to: pr });
      }
    }

    // Due date
    if (updates.dueDate !== undefined && updates.dueDate !== null) {
      const due = String(updates.dueDate).trim() ? assertDateStr_(updates.dueDate) : '';
      const before = readTicketDue_(row[TCOL.DUE], tz);
      if (due !== before) {
        if (!access.canEdit) throw new Error('Only the creator or a Manager can change the due date.');
        checkConflict('dueDate', 'due date', before);
        next[TCOL.DUE] = due;
        changes.push(due ? 'due date set to ' + due : 'due date removed');
        log('due', (before || 'none') + ' → ' + (due || 'none'), { from: before, to: due });
      }
    }

    // Public visibility (before assignees: making a ticket private needs real assignees)
    let isPublicNext = access.isPublic;
    if (updates.isPublic !== undefined && updates.isPublic !== null) {
      const want = updates.isPublic === true;
      if (want !== access.isPublic) {
        if (!access.canAssign) throw new Error('Only a Manager or Admin can change who can see this ticket.');
        checkConflict('isPublic', 'visibility', access.isPublic);
        next[TCOL.PUBLIC] = want;
        isPublicNext = want;
        changes.push(want ? 'made public' : 'made private');
        log('visibility', want ? 'Made the ticket public' : 'Made the ticket private', { to: want });
      }
    }

    // Assignees
    if (updates.assignedTo !== undefined && updates.assignedTo !== null) {
      const wanted = normalizeEmailList_(updates.assignedTo).filter(function (e) { return e !== 'all users'; });
      const before = access.assignees;
      if (!(access.allUsers && wanted.length === 0) && !sameEmailSet_(wanted, before)) {
        if (!access.canAssign) throw new Error('Only a Manager or Admin can reassign a ticket.');
        checkConflict('assignedTo', 'assignees', String(row[TCOL.ASSIGNED_TO] || ''));
        wanted.forEach(function (email) {
          if (!directory.byEmail[email] && before.indexOf(email) === -1) {
            throw new Error('"' + email + '" is not in the Roles directory.');
          }
        });
        if (!wanted.length) {
          if (!isPublicNext) throw new Error('A private ticket needs at least one assignee.');
          next[TCOL.ASSIGNED_TO] = 'All Users';
        } else {
          next[TCOL.ASSIGNED_TO] = wanted.join(', ');
          // An "All Users" ticket stays visible to everyone when it gets named owners.
          if (isPublicNext) next[TCOL.PUBLIC] = true;
        }
        addedAssignees = wanted.filter(function (e) { return before.indexOf(e) === -1; });
        const removed = before.filter(function (e) { return wanted.indexOf(e) === -1; });
        changes.push('reassigned');
        log('assigned', [
          addedAssignees.length ? 'Added ' + addedAssignees.join(', ') : '',
          removed.length ? 'Removed ' + removed.join(', ') : ''
        ].filter(Boolean).join('; ') || 'Changed the assignees', { added: addedAssignees, removed: removed });
      }
    }
    if (!isPublicNext && String(next[TCOL.ASSIGNED_TO]).toLowerCase().trim() === 'all users') {
      throw new Error('Add at least one assignee before making this ticket private.');
    }

    // CC
    if (updates.cc !== undefined && updates.cc !== null) {
      const owners = normalizeEmailList_(next[TCOL.ASSIGNED_TO]);
      const wantedCc = normalizeEmailList_(updates.cc).filter(function (e) { return owners.indexOf(e) === -1; });
      const beforeCc = access.cc;
      if (!sameEmailSet_(wantedCc, beforeCc)) {
        if (!access.canAssign) throw new Error('Only a Manager or Admin can change the CC list.');
        checkConflict('cc', 'CC list', String(row[TCOL.CC] || ''));
        wantedCc.forEach(function (email) {
          if (!directory.byEmail[email] && beforeCc.indexOf(email) === -1) {
            throw new Error('"' + email + '" is not in the Roles directory.');
          }
        });
        next[TCOL.CC] = wantedCc.join(', ');
        const addedCc = wantedCc.filter(function (e) { return beforeCc.indexOf(e) === -1; });
        const removedCc = beforeCc.filter(function (e) { return wantedCc.indexOf(e) === -1; });
        changes.push('CC updated');
        log('cc', [
          addedCc.length ? 'Added ' + addedCc.join(', ') : '',
          removedCc.length ? 'Removed ' + removedCc.join(', ') : ''
        ].filter(Boolean).join('; ') || 'Changed the CC list', { added: addedCc, removed: removedCc });
      }
    }

    // Files attached from an older page (new pages attach files with a comment)
    if (uploaded.length) {
      if (!access.canComment) throw new Error('You cannot add files to this ticket.');
      next[TCOL.ATTACH] = JSON.stringify(parseTicketAttachments_(row[TCOL.ATTACH]).concat(uploaded));
      changes.push(uploaded.length + ' file(s) attached');
      log('attachment', 'Attached ' + uploaded.map(function (f) { return f.name; }).join(', '), { attachments: uploaded });
    }

    if (changes.length) {
      next[TCOL.UPDATED] = nowIso;
      next[TCOL.UPDATED_BY] = user.email;
      const toWrite = next.slice();
      toWrite[TCOL.DESC] = ticketCellText_(toWrite[TCOL.DESC]);
      sheet.getRange(rowIndex, 1, 1, TICKET_WIDTH).setValues([toWrite]);
      appendTicketActivity_(ss, activity);
      notifyMutation_('tickets');
    }
  } catch (err) {
    trashUploaded_(uploaded);
    throw err;
  } finally {
    lock.releaseLock();
  }

  const ticket = ticketToClient_(next, ticketAccess_(next, user), tz);

  // Emails after the lock: new assignees, and the creator when the ticket is finished.
  const emails = { sent: [], error: null };
  if (notify && changes.length) {
    const recordMail = function (to, res) {
      if (res.sent) Array.prototype.push.apply(emails.sent, to);
      else if (res.error) emails.error = res.error;
    };
    const newOwners = addedAssignees.filter(function (e) { return e !== user.email; });
    if (newOwners.length) {
      recordMail(newOwners, sendTicketEmail_(user, ticket, {
        kind: 'assigned', to: newOwners,
        headline: user.email + ' assigned this ' + ticket.ticketType.toLowerCase() + ' to you.',
        body: ticket.description
      }));
    }
    const creator = normalizeEmail_(ticket.assignedBy);
    if (statusChange && (statusChange.to === 'Completed' || statusChange.to === 'Cancelled') && creator && creator !== user.email) {
      recordMail([creator], sendTicketEmail_(user, ticket, {
        kind: 'status', to: [creator],
        headline: user.email + ' marked your ticket ' + statusChange.to + '.',
        body: ''
      }));
    }
  }

  return { success: true, updatedAt: ticket.updatedAt, changes: changes, ticket: ticket, emails: emails };
}

// ==========================================
// COMMENTS
// ==========================================

/** Adds a comment (text, files, or both). options.notify = false skips the email. */
function addTicketComment(ticketKey, text, rawFiles, options) {
  const user = requireTicketWriter_(requireRegistered_());
  const key = String(ticketKey || '').trim();
  if (!key) throw new Error('Ticket not found.');
  const body = String(text === undefined || text === null ? '' : text).trim();
  if (body.length > TICKET_MAX_COMMENT) throw new Error('The comment is too long (max 10,000 characters).');
  const files = Array.isArray(rawFiles) ? rawFiles : [];
  if (!body && !files.length) throw new Error('Write a comment or attach a file.');
  const notify = !(options && options.notify === false);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTicketSchema_(ss, true);
  const tz = ss.getSpreadsheetTimeZone();

  const uploaded = saveAttachmentsToDrive(files);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    trashUploaded_(uploaded);
    throw new Error('The system is busy right now. Please try again in a moment.');
  }

  let next, entry;
  try {
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TICKETS);
    const rowIndex = findTicketRow_(sheet, key);
    if (rowIndex < 2) throw new Error('Ticket not found.');
    const row = readTicketRow_(sheet, rowIndex);
    const access = ticketAccess_(row, user);
    if (!access.canComment) throw new Error('You cannot comment on this ticket.');

    const nowIso = new Date().toISOString();
    next = row.slice();
    next[TCOL.COMMENTS] = (Number(row[TCOL.COMMENTS]) || 0) + 1;
    next[TCOL.UPDATED] = nowIso;
    next[TCOL.UPDATED_BY] = user.email;
    if (uploaded.length) {
      next[TCOL.ATTACH] = JSON.stringify(parseTicketAttachments_(row[TCOL.ATTACH]).concat(uploaded));
    }
    const toWrite = next.slice();
    toWrite[TCOL.DESC] = ticketCellText_(toWrite[TCOL.DESC]);
    sheet.getRange(rowIndex, 1, 1, TICKET_WIDTH).setValues([toWrite]);

    entry = {
      at: nowIso, key: key, no: Number(row[TCOL.NO]) || '', actor: user.email, action: 'comment',
      details: body, meta: uploaded.length ? { attachments: uploaded } : {}
    };
    appendTicketActivity_(ss, [entry]);
    notifyMutation_('tickets');
  } catch (err) {
    trashUploaded_(uploaded);
    throw err;
  } finally {
    lock.releaseLock();
  }

  const ticket = ticketToClient_(next, ticketAccess_(next, user), tz);

  const emails = { sent: [], error: null };
  if (notify) {
    const recipients = ticketParticipants_(ticket).filter(function (e) { return e !== user.email; });
    if (recipients.length) {
      const fileNote = uploaded.length ? '\n\n[' + uploaded.length + ' file(s) attached in the app]' : '';
      const res = sendTicketEmail_(user, ticket, {
        kind: 'comment', to: recipients,
        headline: user.email + ' commented on this ticket.',
        body: (body || '(files only)') + fileNote
      });
      if (res.sent) emails.sent = recipients; else emails.error = res.error;
    }
  }

  return {
    success: true,
    ticket: ticket,
    entry: { at: entry.at, actor: entry.actor, action: entry.action, details: entry.details, meta: entry.meta },
    emails: emails
  };
}

/** People who follow a ticket: assignees, the creator and CC. On an "All Users" ticket: creator and CC only. */
function ticketParticipants_(ticket) {
  const list = [];
  const add = function (e) { if (e && list.indexOf(e) === -1) list.push(e); };
  if (String(ticket.assignedTo).toLowerCase() !== 'all users') normalizeEmailList_(ticket.assignedTo).forEach(add);
  add(normalizeEmail_(ticket.assignedBy));
  normalizeEmailList_(ticket.cc).forEach(add);
  return list;
}

// ==========================================
// EMAIL (sent as the acting user, after the lock; a failed email never fails the save)
// ==========================================

function ticketDeepLink_(key) {
  const base = getWebAppUrl_();
  return base ? base + '?page=tickets&ticketKey=' + encodeURIComponent(key) : '';
}

/**
 * opts: kind ('created' | 'assigned' | 'status' | 'comment'), to [emails], cc [emails], headline, body,
 * includeAttachments. Returns { sent, error }.
 */
function sendTicketEmail_(actor, t, opts) {
  try {
    const to = normalizeEmailList_(opts.to || []);
    const cc = normalizeEmailList_(opts.cc || []).filter(function (e) { return to.indexOf(e) === -1; });
    if (!to.length) return { sent: false, error: null };
    if (to.length + cc.length > TICKET_MAX_EMAIL_RECIPIENTS && opts.kind !== 'created') {
      return { sent: false, error: 'Too many recipients for an update email (' + (to.length + cc.length) + '). Your change was saved.' };
    }

    const typeColor = t.ticketType === 'Issue' ? '#E11D48' : (t.ticketType === 'Flags' ? '#E65100' : '#0077E6');
    const priorityColor = { Urgent: '#BE123C', High: '#C2410C', Normal: '#4A30C8', Low: '#596A82' }[t.priority] || '#4A30C8';
    const title = String(t.description || '').split('\n')[0].trim();
    const shortTitle = title.length > 60 ? title.substring(0, 60) + '...' : title;
    const prefix = '[WFM Operations] ' + (t.label ? t.label + ' ' : '');
    const subject = opts.kind === 'created'
      ? prefix + String(t.ticketType).toUpperCase() + ': ' + shortTitle
      : prefix + (opts.kind === 'comment' ? 'New comment: ' : (opts.kind === 'assigned' ? 'Assigned to you: ' : 'Updated: ')) + shortTitle;
    const link = ticketDeepLink_(t.key);

    let filesHtml = '';
    if (opts.includeAttachments && t.attachments && t.attachments.length) {
      filesHtml = '<div style="margin-top:14px;padding:12px;background:#F8FAFD;border:1px solid #D8E2ED;border-radius:6px;">' +
        '<p style="margin:0 0 8px 0;font-size:11px;font-weight:700;color:#596A82;text-transform:uppercase;">Files (open the ticket in the app to view them)</p>' +
        t.attachments.map(function (att) {
          return '<a href="' + escapeHtml(link) + '" style="display:inline-block;margin:0 8px 6px 0;padding:6px 12px;background:#FFFFFF;border:1px solid #BAE0FF;border-radius:4px;font-size:12px;color:#0077E6;text-decoration:none;font-weight:700;">' +
            escapeHtml(att.name) + ' (' + escapeHtml(att.size || 'File') + ')</a>';
        }).join('') + '</div>';
    }

    const row = function (label, value, style) {
      return '<tr><td style="padding:6px 0;color:#8F9FB5;width:110px;">' + label + '</td><td style="padding:6px 0;' + (style || '') + '">' + value + '</td></tr>';
    };
    const htmlBody =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #EAEFF5;border-radius:8px;overflow:hidden;color:#132238;">' +
        '<div style="background:#032742;padding:18px 24px;color:#FFFFFF;">' +
          '<span style="font-size:15px;font-weight:700;">WFM Operations App</span>' +
          '<span style="float:right;font-size:11px;background:' + typeColor + ';padding:3px 8px;border-radius:4px;text-transform:uppercase;">' +
            escapeHtml(t.ticketType) + (t.label ? ' ' + escapeHtml(t.label) : '') + '</span>' +
        '</div>' +
        '<div style="padding:24px;">' +
          '<div style="background:#EBF5FF;border-left:4px solid ' + typeColor + ';padding:12px 16px;margin-bottom:18px;border-radius:0 4px 4px 0;">' +
            '<p style="margin:0;font-size:14px;font-weight:600;color:#005BB5;">' + escapeHtml(opts.headline || '') + '</p>' +
          '</div>' +
          '<p style="margin:0 0 12px 0;font-size:15px;font-weight:700;">' + escapeHtml(title) + '</p>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">' +
            row('Status', escapeHtml(t.status), 'font-weight:700;') +
            row('Priority', escapeHtml(t.priority), 'font-weight:700;color:' + priorityColor + ';') +
            (t.dueDate ? row('Due', escapeHtml(t.dueDate), 'font-weight:600;') : '') +
            row('Assigned to', escapeHtml(t.assignedTo), 'font-weight:600;') +
            row('Created by', escapeHtml(t.assignedBy)) +
          '</table>' +
          (opts.body
            ? '<div style="background:#F4F6FA;border:1px solid #EAEFF5;border-radius:6px;padding:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;">' +
                escapeHtml(String(opts.body).length > 3000 ? String(opts.body).substring(0, 3000) + '...' : opts.body) + '</div>'
            : '') +
          filesHtml +
          (link
            ? '<div style="text-align:center;margin-top:22px;"><a href="' + escapeHtml(link) + '" style="display:inline-block;background:#0077E6;color:#FFFFFF;padding:10px 24px;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">Open ticket in WFM Operations</a></div>'
            : '') +
        '</div>' +
        '<div style="background:#F4F6FA;padding:14px 24px;border-top:1px solid #EAEFF5;font-size:11px;color:#8F9FB5;text-align:center;">' +
          'Sent by ' + escapeHtml(actor.email) + ' through client Workforce Management System' +
        '</div>' +
      '</div>';

    const mailOptions = { to: to.join(','), subject: subject, htmlBody: htmlBody, replyTo: actor.email };
    if (cc.length) mailOptions.cc = cc.join(',');
    const mail = sendMailAsUser_(mailOptions, to.length + cc.length);
    logNotification_([{
      type: opts.kind === 'created' ? 'ticket' : 'ticket-' + opts.kind,
      from: mail.sentFrom || actor.email,
      to: to.concat(cc).join(', '),
      task: (t.label ? t.label + ' ' : '') + title.substring(0, 60),
      status: mail.queued ? 'queued' : (mail.sent ? 'sent' : 'failed'),
      error: mail.error
    }]);
    return { sent: mail.sent, error: mail.error };
  } catch (err) {
    Logger.log('sendTicketEmail_ failed: ' + err.toString());
    return { sent: false, error: 'The notification email could not be sent. Your change was saved.' };
  }
}