/*
 * background.js — WFM NICE Connector (service worker).
 *
 * Runs NICE WebStation workflows for the WFM App, in a background tab, with the person's own NICE session.
 * A workflow is data sent by the App (each report keeps its own definition in the App); this file only knows how
 * to carry out the generic kinds below, so a new NICE report needs no change here:
 *
 *   nice-report   fill a report form (or open a saved NICE template), press Generate, wait for the new report in
 *                 View Reports, download it (CSV as text, XLS/PDF/DOCX as base64).
 *   nice-fetch    read-only GET of a WebStation page or JSON service (text or JSON back).
 *   nice-extract  read-only GET of a WebStation page and return one of its tables as rows.
 *
 * A run carries one job ({ job }) or several ({ jobs: [...] }, done one after the other in the same tab).
 * Sign-in: only when NICE asks; the NICE tab comes forward, the person signs in, the run continues by itself.
 * Safety: only the NICE host is opened; only /supv/ and /wfm/ paths are used; nice-fetch/extract are GET-only;
 * each App origin is approved once by the person; nothing is stored except approvals and a short run history.
 * Errors carry a code (LOGIN, APPROVAL, BAD_JOB, BUSY, FORM_CHANGED, NICE_REFUSED, NICE_PAGE, TIMEOUT, DOWNLOAD,
 * TAB_CLOSED, CANCELLED, INTERNAL) so the App can explain what to do.
 */
importScripts('nice_page.js');

const NICE = 'https://your-tenant.nicecloudsvc.com';
const LOGIN_HOSTS = ['identity.cloudbreak.us'];
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const HISTORY_MAX = 25;
const CAPS = ['nice-report', 'nice-fetch', 'nice-extract', 'templates', 'steps', 'binary', 'batch', 'codes'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Stop extends Error { constructor(stage, message, code) { super(message); this.stage = stage; this.code = code || 'INTERNAL'; } }

let busy = null;                                                     // one run at a time (all apps, all tabs)

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'wfm-nice') return;
  const ctx = { port, cancelled: false, tabId: null, keepTab: false, appTab: port.sender && port.sender.tab ? port.sender.tab.id : null, t0: Date.now() };
  const origin = (port.sender && (port.sender.origin || (port.sender.url && new URL(port.sender.url).origin))) || '';
  port.onMessage.addListener(async m => {
    if (m.type === 'cancel') { ctx.cancelled = true; return; }
    if (m.type === 'info') { safePost(port, { type: 'info', version: chrome.runtime.getManifest().version, caps: CAPS, busy: !!busy }); return; }
    if (m.type !== 'run') return;
    const list = Array.isArray(m.jobs) ? m.jobs : [m.job];
    const label = list.map(j => (j && (j.report || j.workflow)) || '?').join(' + ');
    let status = 'OK', message = '';
    try {
      if (!/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com$/.test(origin)) throw new Stop('connector', 'This page is not an Apps Script app.', 'APPROVAL');
      if (busy) throw new Stop('connector', 'Another NICE automation is already running in this browser (' + busy + '). Wait for it to finish, then try again.', 'BUSY');
      busy = label;
      await ensureApproved(origin, ctx);
      const jobs = list.map(validJob);
      if (!jobs.length || jobs.length > 10) throw new Stop('connector', 'The app sent ' + jobs.length + ' jobs (1 to 10 allowed).', 'BAD_JOB');
      const results = [];
      for (let i = 0; i < jobs.length; i++) {
        ctx.prefix = jobs.length > 1 ? '[' + (i + 1) + '/' + jobs.length + '] ' : '';
        results.push(await runOne(jobs[i], ctx));
      }
      safePost(port, Object.assign({ type: 'result', seconds: secs(ctx) }, Array.isArray(m.jobs) ? { results } : results[0]));
    } catch (e) {
      status = e.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED'; message = String(e.message || e);
      safePost(port, { type: 'error', stage: e.stage || 'nice', code: e.code || 'INTERNAL', message, seconds: secs(ctx) });
    } finally {
      if (busy === label) busy = null;
      if (ctx.tabId !== null && !ctx.keepTab) { try { await chrome.tabs.remove(ctx.tabId); } catch (ignore) {} }
      remember({ at: Date.now(), origin, report: label, status, seconds: secs(ctx), message: message.slice(0, 200) });
    }
  });
  port.onDisconnect.addListener(() => { ctx.cancelled = true; });
});

function secs(ctx) { return Math.round((Date.now() - ctx.t0) / 1000); }
function safePost(port, m) { try { port.postMessage(m); } catch (ignore) {} }
function progress(ctx, stage, text) { safePost(ctx.port, { type: 'progress', stage, text: (ctx.prefix || '') + text, elapsed: secs(ctx) }); }
function check(ctx) { if (ctx.cancelled) throw new Stop('cancelled', 'Stopped by you. Nothing was changed in the sheet.', 'CANCELLED'); }
async function remember(entry) {
  try { const st = await chrome.storage.local.get('history'); const h = (st.history || []).concat([entry]).slice(-HISTORY_MAX); await chrome.storage.local.set({ history: h }); } catch (ignore) {}
}

/* ------------------------------------------------------------------ approval (once per App) */
async function ensureApproved(origin, ctx) {
  const st = await chrome.storage.local.get('approved');
  const approved = st.approved || {};
  if (approved[origin]) return;
  progress(ctx, 'session', 'Waiting for you to allow this app in the WFM NICE Connector window…');
  const req = 'a' + Date.now() + Math.random().toString(36).slice(2, 8);
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('approve.html') + '?o=' + encodeURIComponent(origin) + '&r=' + req, type: 'popup', width: 480, height: 430, focused: true });
  const allow = await new Promise(resolve => {
    const t = setTimeout(() => { cleanup(); resolve(false); }, 3 * 60 * 1000);
    function onMsg(m) { if (m && m.type === 'approve-result' && m.req === req) { cleanup(); resolve(!!m.allow); } }
    function onClose(id) { if (id === win.id) { cleanup(); resolve(false); } }
    function cleanup() { clearTimeout(t); chrome.runtime.onMessage.removeListener(onMsg); chrome.windows.onRemoved.removeListener(onClose); }
    chrome.runtime.onMessage.addListener(onMsg); chrome.windows.onRemoved.addListener(onClose);
  });
  try { await chrome.windows.remove(win.id); } catch (ignore) {}
  if (!allow) throw new Stop('approval', 'The connector was not allowed to work with this app. Press Start automation again and choose Allow.', 'APPROVAL');
  approved[origin] = { at: Date.now() };
  await chrome.storage.local.set({ approved });
}

/* ------------------------------------------------------------------ job validation (per workflow) */
const RX = {
  shell: /^\/wfm\/supervisor\/[a-z-]+$/,
  form: /^\/supv\/reportAction\.mvc\?[\w=\/.&%-]+$/,
  list: /^\/supv\/reportAction\.mvc\?[\w=\/.&%?-]+$/,
  get: /^\/(supv|wfm|wfmws)\/[\w\/.\-]*(\?[\w=\/.&%?,:+\-]*)?$/,
  oid: /^[0-9a-f]{32}$/,
  formName: /^[A-Za-z]{3,60}Form$/
};
function validJob(j) {
  const bad = msg => { throw new Stop('connector', 'The app sent an invalid job: ' + msg + '.', 'BAD_JOB'); };
  if (!j || typeof j !== 'object') bad('empty');
  const shellPath = j.shellPath || '/wfm/supervisor/reports-generate';
  if (!RX.shell.test(shellPath)) bad('shellPath');
  const timeout = Math.min(Math.max(+j.timeoutSec || 300, 30), 900);
  const base = Object.assign({}, j, { shellPath, timeoutSec: timeout, report: String(j.report || j.workflow || 'NICE').slice(0, 60) });
  if (j.workflow === 'nice-report') {
    if (j.templateOid) { if (!RX.oid.test(j.templateOid)) bad('templateOid'); }
    else if (!RX.form.test(j.formUrl || '')) bad('formUrl');
    if (j.formName && !RX.formName.test(j.formName)) bad('formName');
    if (!RX.list.test(j.listUrl || '/supv/reportAction.mvc?selectedTabAction=/showReportList.mvc?lang=en_US&langFileName=en')) bad('listUrl');
    const steps = j.steps || j.fields || [];
    if (!Array.isArray(steps) || steps.length > 80) bad('steps');
    steps.forEach(s => {
      if (Array.isArray(s)) { if (typeof s[0] !== 'string' || !/^[@\w]{1,60}$/.test(s[0]) || !['string', 'boolean', 'number', 'object'].includes(typeof s[1])) bad('field ' + JSON.stringify(s).slice(0, 60)); return; }
      if (!s || !['set', 'move', 'waitOptions', 'waitFor', 'click', 'call'].includes(s.op)) bad('step ' + JSON.stringify(s).slice(0, 60));
      if (s.op === 'call' && !/^[A-Za-z_$][\w$]*$/.test(s.fn || '')) bad('call ' + s.fn);
    });
    if (!j.match || typeof j.match.name !== 'string') bad('match');
    if (j.format && !/^(CSV|XLS|XLSX|PDF|DOCX)$/.test(j.format)) bad('format');
    return Object.assign(base, { listUrl: j.listUrl || '/supv/reportAction.mvc?selectedTabAction=/showReportList.mvc?lang=en_US&langFileName=en' });
  }
  if (j.workflow === 'nice-fetch' || j.workflow === 'nice-extract') {
    if (!RX.get.test(j.path || '') || /\.\./.test(j.path)) bad('path');
    return base;
  }
  bad('unknown workflow "' + j.workflow + '"');
}

/* ------------------------------------------------------------------ running a job */
async function exec(ctx, func, args) {
  check(ctx);
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId: ctx.tabId }, world: 'MAIN', func, args: args || [] });
      return out && out[0] ? out[0].result : null;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/No tab with id/i.test(msg)) throw new Stop('session', 'The NICE tab was closed. Nothing was changed.', 'TAB_CLOSED');
      // the page was navigating (NICE redirect, refresh): wait and try once more
      if (attempt < 2 && /Frame with ID|was removed|navigat|Cannot access contents|showing error page/i.test(msg)) { await sleep(1500); check(ctx); continue; }
      throw new Stop('nice', 'The NICE page could not be scripted: ' + msg, 'NICE_PAGE');
    }
  }
}
function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }
function isLogin(url) { const h = hostOf(url); return LOGIN_HOSTS.includes(h) || (h.endsWith('nicecloudsvc.com') && /\/login|\/saml|\/sso/i.test(new URL(url).pathname) && !/sso-success/.test(url)); }

/** Opens (or re-opens) WebStation at the shell page and waits until it is usable; handles sign-in when NICE asks for it. */
async function openWebStation(job, ctx) {
  const url = NICE + job.shellPath;
  if (ctx.tabId === null) { const t = await chrome.tabs.create({ url, active: false }); ctx.tabId = t.id; }
  else await chrome.tabs.update(ctx.tabId, { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    check(ctx);
    await sleep(800);
    let tab; try { tab = await chrome.tabs.get(ctx.tabId); } catch (e) { throw new Stop('session', 'The NICE tab was closed. Nothing was changed.', 'TAB_CLOSED'); }
    const u = tab.pendingUrl || tab.url || '';
    if (isLogin(u)) return signIn(job, ctx);
    if (tab.status !== 'complete' || !u.startsWith(NICE + '/wfm/')) continue;
    const p = await exec(ctx, NICE_probe);
    if (p && p.ok) { ctx.ready = true; return; }
    if (p && p.login) return signIn(job, ctx);
  }
  throw new Stop('session', 'NICE WebStation did not open within 45 seconds. Check that you can open it normally, then try again.', 'TIMEOUT');
}
async function ensureSession(job, ctx) {
  if (ctx.ready) return;                                                  // later jobs of a batch reuse the open, signed-in tab
  progress(ctx, 'session', 'Opening NICE WebStation in a background tab…');
  await openWebStation(job, ctx);
  progress(ctx, 'session', 'Using your NICE session');
}

/** Only when NICE asks: bring the NICE tab to the front, wait for the person to sign in, then continue by itself. */
async function signIn(job, ctx) {
  ctx.keepTab = true;                                                     // if anything fails now, leave the sign-in tab open for the person
  ctx.ready = false;
  progress(ctx, 'login', 'NICE asks you to sign in: please sign in in the NICE tab that just opened. The automation continues by itself afterwards.');
  const tab = await chrome.tabs.update(ctx.tabId, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (ignore) {}
  const t0 = Date.now();
  while (Date.now() - t0 < LOGIN_WAIT_MS) {
    check(ctx);
    await sleep(1500);
    let t; try { t = await chrome.tabs.get(ctx.tabId); } catch (e) { throw new Stop('login', 'The NICE sign-in tab was closed before signing in. Nothing was changed.', 'TAB_CLOSED'); }
    const u = t.url || '';
    if (!isLogin(u) && u.startsWith(NICE + '/wfm/') && t.status === 'complete') {
      ctx.keepTab = false;
      progress(ctx, 'session', 'Signed in. Continuing in the background…');
      if (ctx.appTab !== null) { try { const a = await chrome.tabs.update(ctx.appTab, { active: true }); await chrome.windows.update(a.windowId, { focused: true }); } catch (ignore) {} }
      try { await chrome.tabs.update(ctx.tabId, { active: false }); } catch (ignore) {}
      return openWebStation(job, ctx);
    }
  }
  throw new Stop('login', 'Nobody signed in to NICE within 10 minutes. Nothing was changed.', 'LOGIN');
}

/** Runs a page function; when NICE answers with its sign-in page, signs in once and runs it again. */
async function withSession(job, ctx, stage, func, args) {
  let r = await exec(ctx, func, args);
  if (r && !r.ok && r.login) { await signIn(job, ctx); r = await exec(ctx, func, args); }
  if (r && !r.ok && r.login) throw new Stop(stage, 'NICE keeps asking for a sign-in. Sign in to NICE WebStation, then press Start automation again.', 'LOGIN');
  return r;
}

const WORKFLOWS = { 'nice-report': runReport, 'nice-fetch': runFetch, 'nice-extract': runExtract };
async function runOne(job, ctx) {
  await ensureSession(job, ctx);
  return WORKFLOWS[job.workflow](job, ctx);
}

async function runReport(job, ctx) {
  const t0 = Date.now();
  let before = await withSession(job, ctx, 'session', NICE_listReports, [{ listUrl: job.listUrl }]);
  if (!before || !before.ok) throw new Stop('session', (before && before.error) || 'View Reports could not be read.', 'NICE_PAGE');
  const known = new Set((before.rows || []).map(r => r.oid));

  progress(ctx, 'generate', 'Filling the ' + job.report + (job.templateOid ? ' template' : ' form') + ' and pressing Generate…');
  const g = await exec(ctx, NICE_generate, [job]);
  if (!g || !g.ok) {
    if (g && g.login) { await signIn(job, ctx); throw new Stop('generate', 'NICE asked for a new sign-in in the middle of the run. Press Start automation again.', 'LOGIN'); }
    const extra = g && g.code === 'FORM_CHANGED' && g.fieldsFound && g.fieldsFound.length ? ' (fields on the form: ' + g.fieldsFound.slice(0, 30).join(', ') + ')' : '';
    throw new Stop('generate', ((g && g.error) || 'NICE did not accept the report request.') + extra, (g && g.code) || 'NICE_REFUSED');
  }

  progress(ctx, 'wait', 'NICE is preparing the report…');
  const m = job.match, deadline = Date.now() + job.timeoutSec * 1000;
  let found = null, polls = 0, misses = 0, newRows = [];
  while (Date.now() < deadline) {
    await sleep(polls < 5 ? 2500 : 5000); polls++;
    const r = await exec(ctx, NICE_listReports, [{ listUrl: job.listUrl }]);
    if (!r || !r.ok) {
      if (r && r.login) throw new Stop('wait', 'The NICE session ended while waiting. Sign in to NICE and press Start automation again.', 'LOGIN');
      if (++misses > 6) throw new Stop('wait', 'View Reports could not be read several times in a row: ' + ((r && r.error) || 'no answer') + '.', 'NICE_PAGE');
      continue;
    }
    misses = 0;
    newRows = r.rows.filter(x => !known.has(x.oid));
    found = newRows.find(x => x.name === m.name && (!m.subject || x.subject === m.subject) && (!m.start || x.start === m.start) && (!m.end || x.end === m.end) && x.href);
    if (found) break;
    progress(ctx, 'wait', 'NICE is preparing the report… (' + Math.round((Date.now() - t0) / 1000) + ' s)');
  }
  if (!found) {
    const seen = newRows.length ? ' NICE did create: ' + newRows.slice(0, 3).map(x => x.name + ' ' + x.subject + ' ' + x.start + '–' + x.end).join('; ') + ' (not matching the request).' : '';
    throw new Stop('wait', 'NICE did not finish the report within ' + Math.round(job.timeoutSec / 60) + ' minutes. Nothing was changed.' + seen, 'TIMEOUT');
  }
  if (job.format && found.format && found.format !== job.format) throw new Stop('download', 'NICE made the report as ' + found.format + ', not ' + job.format + '.', 'DOWNLOAD');

  progress(ctx, 'download', 'Downloading ' + found.name + ' (' + found.size + ', generated ' + found.generated + ')…');
  let c = null;
  for (let i = 0; i < 3; i++) { c = await exec(ctx, NICE_fetchReport, [{ href: found.href }]); if (c && (c.ok || c.login)) break; await sleep(2000); }
  if (c && c.login) throw new Stop('download', 'The NICE session ended before the download. Sign in to NICE and press Start automation again.', 'LOGIN');
  if (!c || !c.ok) throw new Stop('download', (c && c.error) || 'The report could not be downloaded.', 'DOWNLOAD');
  if (c.format === 'CSV' && job.expectHeader && c.csv.replace(/^﻿/, '').slice(0, job.expectHeader.length) !== job.expectHeader)
    throw new Stop('download', 'The downloaded file is not the expected ' + job.report + ' report (its first line is "' + c.csv.replace(/^﻿/, '').split(/\r?\n/)[0].slice(0, 80) + '").', 'DOWNLOAD');
  const report = { oid: found.oid, name: found.name, subject: found.subject, generated: found.generated, size: found.size, start: found.start, end: found.end, format: c.format, check: g.check || {} };
  return c.format === 'CSV' ? { csv: c.csv, bytes: c.bytes, report } : { base64: c.base64, bytes: c.bytes, mime: c.type, report };
}

async function runFetch(job, ctx) {
  progress(ctx, 'download', 'Reading ' + job.report + ' from NICE…');
  const r = await withSession(job, ctx, 'download', NICE_get, [{ path: job.path, json: !!job.json }]);
  if (!r || !r.ok) throw new Stop('download', (r && r.error) || 'NICE did not answer.', 'DOWNLOAD');
  return r.json !== undefined ? { json: r.json, bytes: r.bytes } : { text: r.text, bytes: r.bytes, mime: r.type };
}

async function runExtract(job, ctx) {
  progress(ctx, 'download', 'Reading ' + job.report + ' from NICE…');
  const r = await withSession(job, ctx, 'download', NICE_extract, [{ path: job.path, table: job.table, rows: job.rows, headerRow: job.headerRow }]);
  if (!r || !r.ok) throw new Stop('download', (r && r.error) || 'NICE did not answer.', (r && r.code) || 'DOWNLOAD');
  return { header: r.header, rows: r.rows };
}
