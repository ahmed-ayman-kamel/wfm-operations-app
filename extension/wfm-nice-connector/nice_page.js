/*
 * nice_page.js — functions injected into the NICE WebStation tab (MAIN world, top frame
 * https://your-tenant.nicecloudsvc.com/wfm/supervisor/...). They use the signed-in person's own session.
 * Each function is self-contained (no closures): chrome.scripting.executeScript serialises it.
 *
 * Every WebStation report follows the same pattern (checked live 2026-10-08 on all 9 report types):
 *   /supv/reportAction.mvc?selectedTabAction=/<Name>ReportMain.mvc&selectedTabOverride=/generateReportWizard.mvc
 *   → form "<Name>ReportForm" → submitForm('generate') → POST <Name>Report.mvc → the report appears in View Reports.
 * Saved NICE templates open the same form already filled in: /supv/reportAction.mvc?schRptOid=<oid>.
 * So one generic "fill the form and press Generate" function serves every report; each report only supplies data.
 */

/**
 * Open a report form (by URL or saved template), apply the steps, press Generate.
 * p: { formUrl | templateOid, formName?, steps|fields: [...], verify?: [names], submit?: { fn, arg }, reportLabel }
 * A step is either the short form [name, value, waitMs] or an object:
 *   { op: 'set', name, value, wait }                       text / select (value or visible text) / radio / checkbox
 *   { op: 'move', from, to, values, fn?, wait }            NICE "move right" lists (e.g. sort order); fn defaults to moveSortOptionRight
 *   { op: 'waitOptions', name, values, timeoutMs }         wait until a list NICE fills late contains these options
 *   { op: 'waitFor', selector, timeoutMs }                 wait for an element in the form page
 *   { op: 'click', selector, wait }                        click an element in the form page
 *   { op: 'call', fn, args, wait }                         call one of the form page's own functions (name only, no code)
 * The legacy name '@sort' = move sortOptions → selectedSortOptions (the Adherence job uses it).
 */
async function NICE_generate(p) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { ok: false, step: 'form', alerts: [] };
  const fail = (code, error, extra) => Object.assign(out, { code: code, error: error }, extra || {});
  try {
    if (/identity\.cloudbreak|\/login/i.test(location.href)) return { ok: false, login: true, code: 'LOGIN', url: location.href };
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) { frame = document.querySelector('iframe[src*="/supv/"]') || document.querySelector('iframe'); if (!frame) await sleep(500); }
    if (!frame) return fail('NICE_PAGE', 'The WebStation page did not load its report area.');
    const loaded = (fr, test, max) => new Promise(res => {
      let n = 0; const t = setInterval(() => {
        n++; let d = null; try { d = fr.contentDocument; } catch (e) {}
        if (d && d.readyState === 'complete' && test(d)) { clearInterval(t); res(d); }
        if (n > (max || 120)) { clearInterval(t); res(null); }
      }, 500);
    });
    const url = p.formUrl || ('/supv/reportAction.mvc?schRptOid=' + p.templateOid);
    const pickForm = doc => p.formName ? doc.forms[p.formName] : Array.from(doc.forms).find(x => /ReportForm$/.test(x.name || ''));
    frame.src = url;
    const d = await loaded(frame, doc => !!pickForm(doc) || !!doc.querySelector('input[type=password]'));
    if (!d) return fail('FORM_CHANGED', 'The ' + p.reportLabel + ' form did not open in WebStation (timeout).');
    if (d.querySelector('input[type=password]')) return { ok: false, login: true, code: 'LOGIN' };
    const w = frame.contentWindow, f = pickForm(d);
    out.formName = f.name;
    // NICE reports problems with alert()/confirm(); capture them instead of blocking the tab.
    w.alert = m => { out.alerts.push(String(m)); };
    w.confirm = m => { out.alerts.push('confirm: ' + String(m)); return false; };
    w.prompt = () => null;
    const fieldNames = () => Array.from(new Set(Array.from(f.elements).map(e => e.name).filter(Boolean)));
    class FormError extends Error {}
    const opts = el => Array.from((el && el.options) || []);
    const matches = (o, v) => o.value === String(v) || o.text.trim() === String(v);
    const fire = (el, types) => types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    const set = (name, value) => {
      const els = f.elements[name];
      if (!els) throw new FormError('Field "' + name + '" is not on the NICE form (NICE may have changed it).');
      const list = els.length !== undefined && !els.tagName ? Array.from(els) : [els];
      const el0 = list[0];
      if (el0.type === 'radio') {
        const r = list.find(x => String(x.value) === String(value));
        if (!r) throw new FormError('Option "' + value + '" is not available for "' + name + '".');
        r.checked = true; fire(r, ['click', 'change']);
      } else if (el0.type === 'checkbox') {
        el0.checked = !!value; fire(el0, ['click', 'change']);
        if (el0.checked !== !!value) el0.checked = !!value;
      } else if (el0.tagName === 'SELECT' && el0.multiple) {
        const want = value === '*' ? null : [].concat(value).map(String);           // '*' = every option in the list
        let n = 0;
        opts(el0).forEach(o => { o.selected = !want || want.some(v => matches(o, v)); if (o.selected) n++; });
        if (!n) throw new FormError('No option could be selected in "' + name + '".');
        fire(el0, ['change']);
      } else if (el0.tagName === 'SELECT') {
        const opt = opts(el0).find(o => o.value === String(value)) || opts(el0).find(o => o.text.trim() === String(value));
        if (!opt) throw new FormError('Option "' + value + '" is not available for "' + name + '" (' + opts(el0).map(o => o.text.trim()).slice(0, 12).join(', ') + ').');
        el0.value = opt.value; fire(el0, ['change']);
      } else {
        el0.value = String(value); fire(el0, ['input', 'change']);
      }
    };
    const waitOptions = async (names, values, ms) => {
      const want = [].concat(values);
      for (let t = 0; t < (ms || 10000); t += 250) {
        const all = [].concat.apply([], [].concat(names).map(n => opts(f.elements[n])));
        if (want.every(v => all.some(o => matches(o, v)))) return;
        await sleep(250);
      }
    };
    const move = (from, to, values, fn) => {
      const src = f.elements[from], dst = f.elements[to], mover = w[fn || 'moveSortOptionRight'];
      if (!src || !dst || typeof mover !== 'function') throw new FormError('The list "' + from + '" → "' + to + '" was not found on the NICE form.');
      [].concat(values).forEach(v => {
        if (opts(dst).some(o => matches(o, v))) return;
        src.multiple = true;                                                       // NICE does the same before moving options
        opts(src).forEach(o => { o.selected = matches(o, v); });
        if (!opts(src).some(o => o.selected)) throw new FormError('Option "' + v + '" is not available in "' + from + '" (' + opts(src).map(o => o.value).join(', ') + ').');
        mover.call(w, from, to);
      });
      opts(dst).forEach(o => { o.selected = true; });                                // selected = submitted
    };
    const steps = (p.steps || p.fields || []).map(s => Array.isArray(s)
      ? (s[0] === '@sort' ? { op: 'move', from: 'sortOptions', to: 'selectedSortOptions', values: s[1], wait: s[2], ensure: true } : { op: 'set', name: s[0], value: s[1], wait: s[2] })
      : s);
    for (const s of steps) {
      out.step = 'form: ' + (s.name || s.from || s.selector || s.fn || s.op);
      if (s.op === 'set') set(s.name, s.value);
      else if (s.op === 'move') { if (s.ensure) await waitOptions([s.from, s.to], s.values, 10000); move(s.from, s.to, s.values, s.fn); }
      else if (s.op === 'waitOptions') await waitOptions(s.name, s.values, s.timeoutMs);
      else if (s.op === 'waitFor') { let ok = false; for (let t = 0; t < (s.timeoutMs || 10000) && !ok; t += 250) { ok = !!d.querySelector(s.selector); if (!ok) await sleep(250); } if (!ok) throw new FormError('"' + s.selector + '" did not appear on the NICE form.'); }
      else if (s.op === 'click') { const x = d.querySelector(s.selector); if (!x) throw new FormError('"' + s.selector + '" is not on the NICE form.'); x.click(); }
      else if (s.op === 'call') { if (!/^[A-Za-z_$][\w$]*$/.test(s.fn || '') || typeof w[s.fn] !== 'function') throw new FormError('The NICE page function "' + s.fn + '" was not found.'); w[s.fn].apply(w, s.args || []); }
      else throw new FormError('Unknown step "' + s.op + '".');
      if (s.wait) await sleep(s.wait);
    }
    // read back what NICE will submit (shown in the app's run details)
    out.check = {};
    for (const k of (p.verify || [])) { const e = f.elements[k]; const x = e && (e.length !== undefined && !e.tagName ? Array.from(e).find(y => y.checked) : e); out.check[k] = !x ? null : x.type === 'checkbox' ? x.checked : (x.tagName === 'SELECT' && x.multiple) ? Array.from(x.selectedOptions).map(o => o.text.trim()).join(', ') : (x.tagName === 'SELECT' ? (x.selectedOptions[0] ? x.selectedOptions[0].text.trim() : '') : x.value); }
    out.format = f.elements.reportFormatTypeOid ? f.elements.reportFormatTypeOid.value : '';
    out.reportName = f.elements.reportName ? f.elements.reportName.value : '';
    out.step = 'submit';
    const sub = p.submit || { fn: 'submitForm', arg: 'generate' };
    if (typeof w[sub.fn] !== 'function') return fail('FORM_CHANGED', 'NICE Generate function "' + sub.fn + '" not found.');
    const before = d;
    const r = w[sub.fn](sub.arg);
    // submitForm may submit at once, or validate the dates over the network first and submit later.
    let left = false;
    for (let i = 0; i < 60; i++) { await sleep(500); let cur = null; try { cur = frame.contentDocument; } catch (e) {} if (cur !== before) { left = true; break; } if (out.alerts.length) break; }
    out.returned = r === undefined ? 'undefined' : String(r);
    if (out.alerts.length && !left) return fail('NICE_REFUSED', 'NICE refused the report: ' + out.alerts.join(' | '));
    if (!left) return fail('NICE_REFUSED', 'NICE did not accept the Generate request (no response in 30 s).');
    const after = await loaded(frame, () => true, 40);
    out.after = after ? after.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (after && after.querySelector('input[type=password]')) return { ok: false, login: true, code: 'LOGIN' };
    out.ok = true; out.step = 'submitted';
    return out;
  } catch (e) {
    const fe = e && e.constructor && e.constructor.name === 'FormError';
    let names = [];
    try { const fr = document.querySelector('iframe'); const f2 = fr && Array.from(fr.contentDocument.forms).find(x => /ReportForm$/.test(x.name || '')); names = f2 ? Array.from(new Set(Array.from(f2.elements).map(x => x.name).filter(Boolean))).slice(0, 80) : []; } catch (ignore) {}
    return fail(fe ? 'FORM_CHANGED' : 'NICE_PAGE', String(e && e.message || e), { fieldsFound: names });
  }
}

/** Is this a usable WebStation page (signed in, report area loaded)? */
async function NICE_probe() {
  const host = location.hostname;
  if (!/nicecloudsvc\.com$/.test(host)) return { ok: false, login: true, url: location.href };
  if (/\/login|sso|saml/i.test(location.pathname)) return { ok: false, login: true, url: location.href };
  for (let i = 0; i < 40; i++) {
    const fr = document.querySelector('iframe[src*="/supv/"]') || document.querySelector('iframe');
    if (fr) return { ok: true };
    if (document.querySelector('input[type=password]')) return { ok: false, login: true, url: location.href };
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, code: 'NICE_PAGE', error: 'WebStation opened but its report area did not load.' };
}

/** The View Reports list (every row: oid, report, subject, start, end, generated, size, link, format). Read-only. */
async function NICE_listReports(p) {
  try {
    const res = await fetch(p.listUrl, { credentials: 'include', cache: 'no-store' });
    if (res.redirected && /login|identity|saml/i.test(res.url)) return { ok: false, login: true };
    const html = await res.text();
    if (!/ReportManagerForm|deleteChkBox/.test(html)) return { ok: false, login: /login|sso|saml|password/i.test(html), error: 'The View Reports list could not be read.' };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const cell = (tr, c) => { const x = tr.querySelector(':scope > td[class^="' + c + '"]'); return x ? x.textContent.replace(/\s+/g, ' ').trim() : ''; };
    const rows = Array.from(doc.querySelectorAll('tr')).filter(tr => tr.querySelector(':scope > td[class^="noteColumn"]')).map(tr => {
      const a = tr.querySelector(':scope > td a[href*="/rv/view"]'), box = tr.querySelector(':scope > td input[name="deleteChkBox"]');
      const href = a ? a.getAttribute('href') : '', fm = /%26f%3D([A-Z]+)/i.exec(href);
      return { oid: box ? box.value : '', name: cell(tr, 'reportColumn'), subject: cell(tr, 'subjectColumn'), start: cell(tr, 'startColumn'), end: cell(tr, 'endColumn'),
               generated: cell(tr, 'generatedTimeColumn'), size: cell(tr, 'sizeColumn'), href: href, format: fm ? fm[1].toUpperCase() : '' };
    });
    return { ok: true, rows: rows };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** Download a finished report (the same request as clicking its icon). CSV comes back as text, other formats as base64. */
async function NICE_fetchReport(p) {
  try {
    if (!/^\/supv\/rv\/view\?encrypted=oid%3D[0-9a-f]+%26f%3D(CSV|XLS|XLSX|PDF|DOCX)$/i.test(p.href)) return { ok: false, error: 'Unexpected report link.' };
    const res = await fetch(p.href, { credentials: 'include', cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, error: 'NICE answered ' + res.status + ' for the report download.' };
    const fmt = /%26f%3D([A-Z]+)$/i.exec(p.href)[1].toUpperCase();
    if (fmt === 'CSV') {
      const text = await res.text();
      if (/text\/html/i.test(type) || /^\s*</.test(text)) return { ok: false, login: /login|sso|saml|password/i.test(text), error: 'NICE returned a web page instead of the CSV.' };
      return { ok: true, format: 'CSV', csv: text, bytes: text.length, type: type };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return { ok: false, error: 'The report is larger than 15 MB.' };
    if (/text\/html/i.test(type) && /password|login/i.test(new TextDecoder().decode(buf.slice(0, 4000)))) return { ok: false, login: true, error: 'NICE returned the sign-in page.' };
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { ok: true, format: fmt, base64: btoa(bin), bytes: buf.length, type: type };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
/** Old name kept for compatibility. */
async function NICE_fetchCsv(p) { return NICE_fetchReport(p); }

/** Read-only GET of a WebStation page or JSON service in the person's session (workflow "nice-fetch"). */
async function NICE_get(p) {
  try {
    const res = await fetch(p.path, { credentials: 'include', cache: 'no-store', headers: p.json ? { Accept: 'application/json' } : {} });
    if (res.redirected && /login|identity|saml/i.test(res.url)) return { ok: false, login: true };
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'NICE answered ' + res.status + ' for ' + p.path + '.' };
    if (p.json) { try { return { ok: true, json: JSON.parse(text), bytes: text.length }; } catch (e) { return { ok: false, login: /password|login/i.test(text), error: 'NICE did not return JSON for ' + p.path + '.' }; } }
    return { ok: true, text: text, bytes: text.length, type: res.headers.get('content-type') || '' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** Read-only: GET a WebStation page and return one of its tables as rows of text (workflow "nice-extract"). */
async function NICE_extract(p) {
  try {
    const res = await fetch(p.path, { credentials: 'include', cache: 'no-store' });
    if (res.redirected && /login|identity|saml/i.test(res.url)) return { ok: false, login: true };
    const html = await res.text();
    if (!res.ok) return { ok: false, error: 'NICE answered ' + res.status + ' for ' + p.path + '.' };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('input[type=password]')) return { ok: false, login: true };
    const table = doc.querySelector(p.table || 'table');
    if (!table) return { ok: false, code: 'FORM_CHANGED', error: 'The table "' + (p.table || 'table') + '" is not on ' + p.path + '.' };
    const txt = c => c.textContent.replace(/\s+/g, ' ').trim();
    const rows = Array.from(table.querySelectorAll(p.rows || 'tr')).map(tr => Array.from(tr.querySelectorAll(':scope > th, :scope > td')).map(txt)).filter(r => r.some(Boolean));
    const head = p.headerRow === null || p.headerRow === undefined ? 0 : p.headerRow;
    return { ok: true, header: head >= 0 ? (rows[head] || []) : [], rows: head >= 0 ? rows.slice(head + 1) : rows };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
