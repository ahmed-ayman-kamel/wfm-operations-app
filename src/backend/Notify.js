/**
 * Notify.gs
 * All outgoing email. Because the web app executes as the visiting user, MailApp sends every
 * message FROM THAT USER'S OWN GOOGLE ACCOUNT and the daily quota is per user, not shared.
 *
 * Design rules
 * - A failed email never fails the save. The caller gets { sent:false, error } and shows a toast.
 * - Every interpolated value in an HTML body goes through escapeHtml().
 * - Recipients are validated against the Roles directory before anything is sent.
 * - Every attempt is written to the "Notification Log" sheet (append-only audit).
 */

const NOTIFY_LOG_HEADERS = ['Timestamp', 'Type', 'From', 'To', 'Date', 'Shift', 'Task', 'Status', 'Error'];
const MAX_MENTIONS_PER_COMMENT = 10;

// ------------------------------------------------------------------
// Low-level send + audit log
// ------------------------------------------------------------------

function sendMailAsUser_(mailOptions, recipientCount) {
  // Backend API: the mail is handed to the front app, which sends it from the signed-in person's
  // own account (see Api.gs). Nothing is sent from the owner's account.
  if (typeof API_OUTBOX_ !== 'undefined' && API_OUTBOX_) {
    API_OUTBOX_.push(mailOptions);
    return { sent: true, queued: true, sentFrom: currentUserEmail_(), error: null };
  }
  const mode = getAuthMode_();
  try {
    const remaining = MailApp.getRemainingDailyQuota();
    if (remaining < recipientCount) {
      return {
        sent: false,
        sentFrom: mode.active,
        error: 'Daily email quota reached (' + remaining + ' left, ' + recipientCount + ' needed). Your change was saved.'
      };
    }
    MailApp.sendEmail(mailOptions);
    // If the deployment is still in owner mode the mail leaves from the owner. Say so.
    return { sent: true, sentFrom: mode.executesAsUser ? mode.active : (mode.effective || ''), error: null };
  } catch (err) {
    Logger.log('Email dispatch failed: ' + err.toString());
    return { sent: false, sentFrom: mode.active, error: 'Notification could not be sent. Your change was saved.' };
  }
}

function logNotification_(entries) {
  if (!entries || !entries.length) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.NOTIFY_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEETS.NOTIFY_LOG);
      sheet.appendRow(NOTIFY_LOG_HEADERS);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, NOTIFY_LOG_HEADERS.length).setFontWeight('bold');
    }
    const now = new Date().toISOString();
    const rows = entries.map(function (e) {
      return [now, e.type, e.from, e.to, e.date || '', e.shift || '', e.task || '', e.status, e.error || ''];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, NOTIFY_LOG_HEADERS.length).setValues(rows);
  } catch (e) {
    Logger.log('Notification log failed: ' + e.toString());
  }
}

// ------------------------------------------------------------------
// Mentions
// ------------------------------------------------------------------

/**
 * Finds "@person@company.com" tokens. Only accounts in the Roles directory count.
 * Returns unique lowercase emails in order of appearance.
 */
function extractMentions_(text, directory) {
  const found = [];
  const seen = {};
  const source = String(text || '');
  const re = /(?:^|[^A-Za-z0-9._%+\-])@([A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const email = normalizeEmail_(m[1]);
    if (seen[email]) continue;
    seen[email] = true;
    if (directory.byEmail[email]) found.push(email);
  }
  return found;
}

/** Mentions present in newText but not in oldText, excluding the author. */
function newMentionsBetween_(oldText, newText, directory, authorEmail) {
  const before = {};
  extractMentions_(oldText, directory).forEach(function (e) { before[e] = true; });
  return extractMentions_(newText, directory).filter(function (e) {
    return !before[e] && e !== authorEmail;
  });
}

function buildTodoDeepLink_(dateStr, shift, taskName) {
  const base = getWebAppUrl_();
  if (!base) return '#';
  return base + '?page=todo&date=' + encodeURIComponent(dateStr) +
    '&shift=' + encodeURIComponent(shift) + '&task=' + encodeURIComponent(taskName);
}

/**
 * Emails people newly @mentioned in a to-do comment. Runs AFTER the write lock is released.
 * Returns { notified: [emails], skipped: [{email, reason}], error: string|null, sentFrom }
 */
function notifyCommentMentions_(actor, ctx) {
  const result = { notified: [], skipped: [], error: null, sentFrom: '' };
  try {
    if (ctx.enabled === false) return result;

    const directory = getRolesDirectory_();
    let targets = newMentionsBetween_(ctx.oldComment, ctx.newComment, directory, actor.email);
    if (!targets.length) return result;

    if (targets.length > MAX_MENTIONS_PER_COMMENT) {
      targets.slice(MAX_MENTIONS_PER_COMMENT).forEach(function (e) {
        result.skipped.push({ email: e, reason: 'Limit of ' + MAX_MENTIONS_PER_COMMENT + ' mentions per comment' });
      });
      targets = targets.slice(0, MAX_MENTIONS_PER_COMMENT);
    }

    const link = buildTodoDeepLink_(ctx.date, ctx.shift, ctx.taskName);
    const excerpt = String(ctx.newComment || '').trim();
    const shortExcerpt = excerpt.length > 600 ? excerpt.substring(0, 600) + '...' : excerpt;
    const subjectTask = String(ctx.taskName).length > 60 ? String(ctx.taskName).substring(0, 60) + '...' : ctx.taskName;

    const htmlBody =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #EAEFF5;border-radius:8px;overflow:hidden;color:#132238;">' +
        '<div style="background:#032742;padding:18px 24px;color:#FFFFFF;">' +
          '<span style="font-size:15px;font-weight:700;">WFM Operations App</span>' +
          '<span style="float:right;font-size:11px;background:#7C5CFF;padding:3px 8px;border-radius:4px;">Mention</span>' +
        '</div>' +
        '<div style="padding:24px;">' +
          '<p style="margin:0 0 16px 0;font-size:14px;line-height:1.5;"><strong>' + escapeHtml(actor.email) +
            '</strong> mentioned you in a comment. Please review it.</p>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">' +
            '<tr><td style="padding:6px 0;color:#8F9FB5;width:90px;">Task</td><td style="padding:6px 0;font-weight:700;">' + escapeHtml(ctx.taskName) + '</td></tr>' +
            '<tr><td style="padding:6px 0;color:#8F9FB5;">Date</td><td style="padding:6px 0;">' + escapeHtml(ctx.date) + '</td></tr>' +
            '<tr><td style="padding:6px 0;color:#8F9FB5;">Shift</td><td style="padding:6px 0;">' + escapeHtml(ctx.shift) + '</td></tr>' +
          '</table>' +
          '<div style="background:#F4F6FA;border:1px solid #EAEFF5;border-radius:6px;padding:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;">' + escapeHtml(shortExcerpt) + '</div>' +
          '<div style="text-align:center;margin-top:22px;">' +
            '<a href="' + escapeHtml(link) + '" style="display:inline-block;background:#0077E6;color:#FFFFFF;padding:10px 24px;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">Open task in WFM Operations</a>' +
          '</div>' +
        '</div>' +
        '<div style="background:#F4F6FA;padding:14px 24px;border-top:1px solid #EAEFF5;font-size:11px;color:#8F9FB5;text-align:center;">' +
          'Sent by ' + escapeHtml(actor.email) + ' through client Workforce Management System' +
        '</div>' +
      '</div>';

    const mail = sendMailAsUser_({
      to: targets.join(','),
      subject: '[WFM Operations] You were mentioned: ' + subjectTask + ' (' + ctx.shift + ', ' + ctx.date + ')',
      htmlBody: htmlBody,
      replyTo: actor.email
    }, targets.length);

    result.sentFrom = mail.sentFrom;
    if (mail.sent) {
      result.notified = targets;
    } else {
      result.error = mail.error;
      targets.forEach(function (e) { result.skipped.push({ email: e, reason: mail.error }); });
    }

    logNotification_(targets.map(function (e) {
      return {
        type: 'mention', from: mail.sentFrom || actor.email, to: e, date: ctx.date, shift: ctx.shift,
        task: ctx.taskName, status: mail.queued ? 'queued' : (mail.sent ? 'sent' : 'failed'), error: mail.error
      };
    }));
  } catch (err) {
    Logger.log('notifyCommentMentions_ failed: ' + err.toString());
    result.error = 'Mention notification could not be sent. Your comment was saved.';
  }
  return result;
}

// ------------------------------------------------------------------
// Ticket notification (same look as before; every value escaped; sends as the acting user)
// ------------------------------------------------------------------

function sendTicketNotificationEmail_(t) {
  try {
    const webAppUrl = getWebAppUrl_();
    const openLink = webAppUrl
      ? webAppUrl + '?page=tickets&ticketKey=' + encodeURIComponent(t.createdAt)
      : '#';
    const cleanCC = t.cc ? t.cc.split(',').map(function (e) { return e.trim(); }).filter(Boolean) : [];

    let targetTo = t.assignedTo;
    if (String(t.assignedTo || '').toLowerCase() === 'all users') {
      targetTo = getRolesDirectory_().list.map(function (u) { return u.email; }).join(',');
    }

    const toEmails = String(targetTo).split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
    const uniqueTo = Array.from(new Set(toEmails));
    const uniqueCc = cleanCC.filter(function (c) { return uniqueTo.indexOf(c.toLowerCase()) === -1; });

    const recipientCount = uniqueTo.length + uniqueCc.length;

    let typeColor = '#0077E6';
    if (t.ticketType === 'Issue') typeColor = '#E11D48';
    if (t.ticketType === 'Flags') typeColor = '#E65100';

    const subject = '[WFM Operations] ' + String(t.ticketType).toUpperCase() + ': ' +
      t.description.substring(0, 45) + (t.description.length > 45 ? '...' : '');

    let attachmentsHtml = '';
    if (t.attachments && t.attachments.length > 0) {
      attachmentsHtml =
        '<div style="margin-top:16px; padding:12px; background:#F8FAFD; border:1px solid #D8E2ED; border-radius:6px;">' +
          '<p style="margin:0 0 8px 0; font-size:11px; font-weight:700; color:#596A82; text-transform:uppercase;">Attached files (open the ticket in the app to view them):</p>' +
          t.attachments.map(function (att) {
            return '<a href="' + escapeHtml(openLink) + '" target="_blank" style="display:inline-block; margin-right:8px; margin-bottom:6px; padding:6px 12px; background:#FFFFFF; border:1px solid #BAE0FF; border-radius:4px; font-size:12px; color:#0077E6; text-decoration:none; font-weight:700;">' +
              escapeHtml(att.name) + ' (' + escapeHtml(att.size) + ')</a>';
          }).join('') +
        '</div>';
    }

    const htmlBody =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif; max-width:600px; margin:0 auto; background:#FFFFFF; border:1px solid #EAEFF5; border-radius:8px; overflow:hidden; color:#132238;">' +
        '<div style="background:#032742; padding:18px 24px; color:#FFFFFF;">' +
          '<span style="font-size:15px; font-weight:700;">WFM Operations App</span>' +
          '<span style="float:right; font-size:11px; background:' + typeColor + '; padding:3px 8px; border-radius:4px; text-transform:uppercase;">' + escapeHtml(t.ticketType) + ' Dispatch</span>' +
        '</div>' +
        '<div style="padding:24px;">' +
          '<div style="background:#EBF5FF; border-left:4px solid ' + typeColor + '; padding:12px 16px; margin-bottom:20px; border-radius:0 4px 4px 0;">' +
            '<p style="margin:0; font-size:14px; font-weight:600; color:#005BB5;">' +
              (t.isPublic ? 'Public Announcement' : 'Action Required') + ': A new ' + escapeHtml(t.ticketType) + ' has been assigned.' +
            '</p>' +
            '<p style="margin:4px 0 0 0; font-size:12px; color:#596A82;">Dispatched by: ' + escapeHtml(t.assignedBy) + '</p>' +
          '</div>' +
          '<table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:20px;">' +
            '<tr><td style="padding:8px 0; color:#8F9FB5; width:110px;">Ticket Type:</td><td style="padding:8px 0; font-weight:700; color:' + typeColor + ';">' + escapeHtml(t.ticketType) + '</td></tr>' +
            '<tr><td style="padding:8px 0; color:#8F9FB5;">Status:</td><td style="padding:8px 0; font-weight:600; color:#059669;">' + escapeHtml(t.status) + '</td></tr>' +
            '<tr><td style="padding:8px 0; color:#8F9FB5;">Assigned To:</td><td style="padding:8px 0; font-weight:600;">' + escapeHtml(t.assignedTo) + '</td></tr>' +
            '<tr><td style="padding:8px 0; color:#8F9FB5;">Assigned By:</td><td style="padding:8px 0; font-weight:500;">' + escapeHtml(t.assignedBy) + '</td></tr>' +
          '</table>' +
          '<div style="margin-bottom:24px;">' +
            '<p style="font-size:11px; font-weight:600; color:#596A82; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Description</p>' +
            '<div style="background:#F4F6FA; border:1px solid #EAEFF5; border-radius:6px; padding:14px; font-size:13px; line-height:1.5; white-space:pre-wrap; color:#132238;">' + escapeHtml(t.description) + '</div>' +
            attachmentsHtml +
          '</div>' +
          (uniqueCc.length > 0
            ? '<div style="background:#FFF8E7; border:1px solid #FDE68A; border-radius:6px; padding:12px; font-size:12px; color:#D97706; margin-bottom:24px;">' +
                '<strong>CC Visibility Notice:</strong> ' + escapeHtml(uniqueCc.join(', ')) + '<br>' +
                '<em>You have been CC\'d for operational visibility only. You are not the assigned owner of this ticket.</em></div>'
            : '') +
          '<div style="text-align:center; margin-top:10px;">' +
            '<a href="' + escapeHtml(openLink) + '" style="display:inline-block; background:#0077E6; color:#FFFFFF; padding:10px 24px; text-decoration:none; border-radius:6px; font-size:13px; font-weight:600;">Open Ticket in WFM Operations</a>' +
          '</div>' +
        '</div>' +
        '<div style="background:#F4F6FA; padding:14px 24px; border-top:1px solid #EAEFF5; font-size:11px; color:#8F9FB5; text-align:center;">' +
          'client Workforce Management System &bull; Contact Center Operations' +
        '</div>' +
      '</div>';

    const mailOptions = { to: uniqueTo.join(','), subject: subject, htmlBody: htmlBody };
    if (uniqueCc.length > 0 && String(t.assignedTo || '').toLowerCase() !== 'all users') {
      mailOptions.cc = uniqueCc.join(',');
    }

    const mail = sendMailAsUser_(mailOptions, recipientCount);
    logNotification_([{
      type: 'ticket', from: mail.sentFrom || t.assignedBy, to: uniqueTo.concat(uniqueCc).join(', '),
      task: t.description.substring(0, 60), status: mail.queued ? 'queued' : (mail.sent ? 'sent' : 'failed'), error: mail.error
    }]);
    return { sent: mail.sent, error: mail.error };
  } catch (err) {
    Logger.log('Notification email dispatch failed: ' + err.toString());
    return { sent: false, error: 'Notification could not be sent. Ticket was saved.' };
  }
}