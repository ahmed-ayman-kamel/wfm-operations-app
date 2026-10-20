/**
 * Hardening.gs — owner/Admin tools run from the editor (not callable from the app).
 *
 *   hardenSheets()      run ONCE: makes every free-text column "plain text", so nothing a user types
 *                       (for example =IMPORTRANGE(...) or =IMAGE(...)) can ever run as a formula.
 *   reportAccess()      read-only: lists who can open the WFM App sheet, the attachments folder and the
 *                       Voyce / Adherence / MVCC data sheets, and flags anything open to "anyone with the link".
 *   closeLinkSharing()  turns off "anyone with the link" everywhere (people added by name keep access).
 *   lockAttachmentsFolder('YES')   makes the attachments folder private (owner only). Run it ONLY after
 *                       everyone uses the new app: the old app opens files with each person's own access.
 */

/** Sheet → the columns (by header name) that hold text typed by people. */
const HARDEN_TEXT_COLUMNS_ = {
  'Todo List': ['Task Name', 'Assigned To', 'Received By', 'Comment'],
  'Tickets': ['Assigned To', 'Assigned By', 'Description', 'CC'],
  'Ticket Activity': ['Actor', 'Action', 'Details', 'Meta'],
  'Shift Closures': ['Closed By', 'Handover Notes'],
  'Notification Log': ['Type', 'From', 'To', 'Task', 'Error'],
  'Audit Log': ['Timestamp', 'Email', 'Role', 'Action', 'Result', 'Details']
};

function hardenSheets() {
  requireSetupAccess_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  apiAuditSheet_();                                    // make sure the Audit Log exists
  const report = [];
  Object.keys(HARDEN_TEXT_COLUMNS_).forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { report.push('skipped (no such sheet): ' + name); return; }
    const lastCol = sheet.getLastColumn();
    if (!lastCol) { report.push('skipped (empty): ' + name); return; }
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
    const done = [];
    HARDEN_TEXT_COLUMNS_[name].forEach(function (h) {
      const idx = headers.indexOf(h);
      if (idx === -1) return;
      sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
      done.push(h);
    });
    report.push(name + ': plain text → ' + (done.length ? done.join(', ') : '(no matching columns)'));
  });
  Logger.log(report.join('\n'));
  return report;
}

/** Every file/folder the app depends on: { label, item } (item = Drive file or folder). */
function accessTargets_() {
  const out = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  out.push({ label: 'SHEET "' + ss.getName() + '" (the app database)', item: DriveApp.getFileById(ss.getId()) });
  try { out.push({ label: 'ATTACHMENTS FOLDER', item: getCachedAttachmentsFolder() }); }
  catch (e) { out.push({ label: 'ATTACHMENTS FOLDER', error: e.message }); }
  [['VOYCE ONLINE HOURS sheet', 'VOH_ss_'], ['ADHERENCE data sheet', 'ADH_ss_'], ['MVCC data sheet', 'MV_ss_']].forEach(function (t) {
    try {
      const other = globalThis[t[1]]();
      out.push({ label: t[0] + ' "' + other.getName() + '"', item: DriveApp.getFileById(other.getId()) });
    } catch (e) { out.push({ label: t[0], error: e.message }); }
  });
  return out;
}

function reportAccess() {
  requireSetupAccess_();
  const lines = [];
  const names = function (users) { return users.map(function (u) { return u.getEmail(); }).join(', ') || '(none)'; };
  accessTargets_().forEach(function (t) {
    lines.push(t.label);
    if (t.error) { lines.push('  could not check: ' + t.error); return; }
    const it = t.item;
    let owner = '';
    try { owner = it.getOwner().getEmail(); } catch (e) { owner = '(unknown)'; }
    const access = String(it.getSharingAccess());
    lines.push('  owner:   ' + owner);
    lines.push('  editors: ' + names(it.getEditors()));
    lines.push('  viewers: ' + names(it.getViewers()));
    lines.push('  link sharing: ' + access + ' / ' + it.getSharingPermission() + (access !== 'PRIVATE' ? '   <<< OPEN TO ANYONE WITH THE LINK' : ''));
  });
  Logger.log(lines.join('\n'));
  return lines;
}

/**
 * Turns off "anyone with the link" on every file/folder above. People who were added by name keep
 * their access, so the old app keeps working. Safe to run now.
 */
function closeLinkSharing() {
  requireSetupAccess_();
  const lines = [];
  accessTargets_().forEach(function (t) {
    if (t.error) { lines.push('skipped (' + t.label + '): ' + t.error); return; }
    const before = String(t.item.getSharingAccess());
    if (before === 'PRIVATE') { lines.push(t.label + ': already private'); return; }
    try {
      t.item.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      lines.push(t.label + ': link sharing was ' + before + ' → now PRIVATE (people added by name keep access)');
    } catch (e) { lines.push(t.label + ': could not change (' + e.message + ')'); }
  });
  Logger.log(lines.join('\n'));
  return lines;
}

function lockAttachmentsFolder(confirm) {
  requireSetupAccess_();
  if (confirm !== 'YES') {
    throw new Error('Not done. This makes the attachments folder private (owner only). Run it as lockAttachmentsFolder("YES") after everyone uses the new app.');
  }
  const folder = getCachedAttachmentsFolder();
  folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  folder.getEditors().forEach(function (u) { try { folder.removeEditor(u); } catch (e) {} });
  folder.getViewers().forEach(function (u) { try { folder.removeViewer(u); } catch (e) {} });
  Logger.log('Attachments folder is now private. Files open only inside the app.');
  return reportAccess();
}

/** People who keep READ-ONLY access to the sheet and the attachments folder after the lockdown. */
const LOCKDOWN_KEEP_VIEWERS_ = ['ahmedaymankamel.a@gmail.com'];

/**
 * The final step. Removes everybody except the owner from the app database sheet and the attachments
 * folder (the emails in LOCKDOWN_KEEP_VIEWERS_ stay as read-only viewers). The Voyce / Adherence / MVCC data
 * sheets are NOT touched here (other people may use them): decide those one by one.
 *   lockdownAccess()        → shows what would happen, changes nothing
 *   lockdownAccess('YES')   → does it. Refuses unless the old link is already in redirect mode.
 */
function lockdownAccess(confirm) {
  requireSetupAccess_();
  const apply = (confirm === 'YES');
  if (apply && PropertiesService.getScriptProperties().getProperty('WFM_OLD_APP_MODE') !== 'redirect') {
    throw new Error('Not done: switch the old link to the new app first (script property WFM_OLD_APP_MODE = redirect). Otherwise the old app breaks for everyone.');
  }
  const keep = LOCKDOWN_KEEP_VIEWERS_.map(function (e) { return e.toLowerCase(); });
  const lines = [apply ? 'DONE:' : 'DRY RUN (nothing changed). To apply, run lockdownAccess("YES"):'];
  accessTargets_().forEach(function (t) {
    if (t.error || !(/^SHEET "/.test(t.label) || /^ATTACHMENTS/.test(t.label))) return;
    const it = t.item;
    let owner = '';
    try { owner = it.getOwner().getEmail().toLowerCase(); } catch (e) {}
    const people = {};
    it.getEditors().concat(it.getViewers()).forEach(function (u) {
      const em = u.getEmail();
      if (em && em.toLowerCase() !== owner) people[em] = true;
    });
    lines.push(t.label);
    Object.keys(people).forEach(function (em) {
      const stay = keep.indexOf(em.toLowerCase()) !== -1;
      lines.push('  ' + (stay ? 'read-only viewer: ' : 'remove: ') + em);
      if (!apply) return;
      try { it.removeEditor(em); } catch (e) {}
      try { it.removeViewer(em); } catch (e) {}
      if (stay) { try { it.addViewer(em); } catch (e) {} }
    });
    if (apply) { try { it.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) {} }
  });
  if (apply) PropertiesService.getScriptProperties().setProperty('WFM_LOCKED_DOWN', new Date().toISOString());
  Logger.log(lines.join('\n'));
  return lines;
}

/** One-click version for the editor's Run button (the dropdown cannot pass "YES"). Does the real lockdown. */
function lockdownNow() {
  return lockdownAccess('YES');
}
