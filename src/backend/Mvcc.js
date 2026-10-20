/**
 * Mvcc.gs — NEW FILE (changes no existing file).
 * -----------------------------------------------------------------------------
 * MVCC daily report → the "MVCC Data" spreadsheet.
 *
 *   A. MVCC data   ← Sisense "Vendor Dashboard" › Calls Event by Vendor Log   (one pull per day)
 *   B. AHT         ← Sisense "Vendor Dashboard" › ICS Detail (Interpreters)   + "Vendor Operator Dashboard" › ICS Detail (Operators)
 *   C. Short calls ← Sisense "Vendor Dashboard" › Short Call Details (CUSTOMER_CANCELLED rows removed)
 *   D. Paid Hours  ← NICE Time Utilization (2 CSV reports, run by the WFM NICE Connector in the person's own browser)
 *
 * Rules (owner, 2026-10-13):
 *   - Reports are updated only up to YESTERDAY (New York time).
 *   - Sisense filters: Status = Active + Terminated - Eligible; MVCC data: Role = Interpreter + Operator;
 *     AHT/Short calls: Role = Interpreter (operators come from the Operator dashboard).
 *   - Sisense can still change a day for a few days, so every run re-pulls the last 3 days (backfill) and REPLACES those dates.
 *   - Agents that are not in the Database are NOT written to MVCC data; they are listed in the _Flags tab.
 *   - Duplicate rows (same agent twice on one day) are flagged in _Flags; whether they are kept is the setting in _Control B14
 *     (KEEP = as Sisense returns them, REMOVE = keep the first row only).
 *
 * Public entry points (all guarded):
 *   setupMvccSheet()                  editor    requireSetupAccess_
 *   repairMvccFormulas()              editor    requireSetupAccess_
 *   mvccCheckSetup()                  editor    requireSetupAccess_ (read-only)
 *   TEST_mvccSisenseProbe()           editor    requireSetupAccess_ (logs in, fetches one day, writes nothing)
 *   mvccBackfillSisense()             app       run roles           (last 3 days: MVCC data + AHT + Short calls)
 *   mvccLoadSisenseRange(from, to)    app/editor run roles or owner  (any range <= 31 days; resumable)
 *   mvccStartPaidHours()              app       run roles           (returns the NICE jobs for the 1st → yesterday)
 *   mvccSavePaidHours(runId, c1, c2)  app       run roles           (the 2 CSVs the extension downloaded)
 *   mvccReportRunFailure(...)         app       run roles
 *
 * Depends on (existing): requireRegistered_(), requireSetupAccess_(), dashRole_() (Dashboards.gs).
 * Script Properties: MVCC_SPREADSHEET_ID (the existing "MVCC Data" id), SISENSE_USERNAME, SISENSE_PASSWORD (already used by the Voyce report).
 * No ScriptApp, no new OAuth scope (UrlFetchApp is already used by ReportAutomation).
 */

var MVCC = {
  TZ: 'America/New_York',
  PROP_ID: 'MVCC_SPREADSHEET_ID',
  DATA: 'MVCC data', AHT: 'AHT', SHORT: 'Short calls', PAID: 'Paid Hours', DB: 'Database', ALIAS: 'Aliases',
  CONTROL: '_Control', LOG: '_Load Log', FLAGS: '_Flags',
  RUN_ROLES: ['RTM', 'Manager', 'Admin'],
  RUN_FLAG: 'MVCC_RUNNING', RUN_FLAG_TTL: 330,
  RUN_TTL: 1800,
  BACKFILL_DAYS: 3,
  MAX_DAYS: 31,
  RUN_BUDGET_MS: 240000,                 // stop starting new days after ~4 min (Apps Script limit is 6 min)
  WRITE_CHUNK: 20000,
  CELL_WARN: 8000000,
  MAX_RETRY_LOGIN: 1,

  SIS_HOST: 'https://your-tenant.sisense.com',
  SIS_PROP_USER: 'SISENSE_USERNAME', SIS_PROP_PASS: 'SISENSE_PASSWORD',
  SIS_TOKEN_KEY: 'MVCC_SIS_TOKEN',
  SIS_DS_VENDOR: { address: 'LocalHost', title: 'vendor _SF (1)', id: 'localhost_avendorIAAaXwAaSFIAAaKAAa1KQAa',
                   database: 'avendorIAAaXwAaSFIAAaKAAa1KQAa', fullname: 'localhost/vendor _SF (1)', live: false },
  SIS_DS_OPER: { address: 'LocalHost', title: 'Vendor Comparision (temp_Csat) _SF',
                 id: 'localhost_aVendorIAAaComparisionIAAaKAAatempXwAaCsatKQAaIAAaXwAaSF',
                 database: 'aVendorIAAaComparisionIAAaKAAatempXwAaCsatKQAaIAAaXwAaSF',
                 fullname: 'localhost/Vendor Comparision (temp_Csat) _SF', live: false },

  // Sheet columns (row 1 headers are expected as they are in the workbook)
  DATA_LOAD_COLS: 11,                    // A:K loaded; B and L:Z are formulas
  DATA_TOTAL_COLS: 26,
  AHT_COLS: 9, SHORT_COLS: 10, PAID_COLS: 9,
  DEDUPE_CELL: 'B14',                    // _Control: KEEP | REMOVE
  CHECKSUM_ROW: 16,                      // _Control B16: lookup checksum (the dashboard cache follows Database changes)

  // Database columns used by the MVCC data formulas, found by header name (row 1 of the Database tab).
  DB_COLS: { icol: 'Interpreter name', nname: 'Name on Nice', seat: 'Seat Number', lg: 'Language Group',
             email: 'Email Address', nice: 'Nice ID', mgr: 'Manager', sup: 'Supervisor', seatLang: 'Seat Language' },

  // NICE Time Utilization (MU set "6 FG")
  NICE_VIEW_OID: 'YOUR_NICE_VIEW_OID',
  NICE_CODES_SCHED: [   // Report 1: Data = Schedules
    { id: 'YOUR_NICE_CODE_QA_MEETING', oid: 'YOUR_NICE_CODE_QA_MEETING', name: 'QA Meeting' },
    { id: 'as.ntt.excp.22', oid: 'as.ntt.excp.22', name: 'Training' },
    { id: 'as.ntt.excp.20', oid: 'as.ntt.excp.20', name: 'Coaching' },
    { id: 'as.ntt.excp.23', oid: 'as.ntt.excp.23', name: 'Special Project' },
    { id: 'as.ntt.excp.24', oid: 'as.ntt.excp.24', name: 'System Issues' }],
  NICE_CODES_ACT: [     // Report 2: Data = Agent Activity
    { id: 'YOUR_NICE_CODE_ACW', oid: 'YOUR_NICE_CODE_ACW', name: 'ACW' },
    { id: 'YOUR_NICE_CODE_BUSY', oid: 'YOUR_NICE_CODE_BUSY', name: 'Busy' },
    { id: 'Open Code', oid: 'Open Code', name: 'Open' }]
};

/* ============================== SISENSE TEMPLATES ============================== */
/**
 * The JAQL of the dashboard widgets, exactly as the dashboards send it (verified 2026-10-13 against the live widgets).
 * '@DATE' is replaced by {from,to} of the requested day.
 */
function MV_d_(t, c, type, title, extra) {
  var j = { table: t, column: c, dim: '[' + t + '.' + c + ']', datatype: type, title: title };
  if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) j[k] = extra[k];
  return j;
}
function MV_days_(t, c, title, dimSuffix) {
  return { table: t, column: c, dim: '[' + t + '.' + (dimSuffix || c) + ' (Calendar)]', datatype: 'datetime', level: 'days', title: title };
}
function MV_in_(j, members) { j.filter = { explicit: true, multiSelection: true, members: members }; return j; }
function MV_r_(j) { return { panel: 'rows', jaql: j }; }
function MV_m_(j) { return { panel: 'measures', jaql: j }; }
function MV_s_(j) { return { panel: 'scope', jaql: j }; }
function MV_ctx_(t, c, title, agg) {
  var o = { table: t, column: c, dim: '[' + t + '.' + c + ']', datatype: 'numeric', title: title };
  if (agg) o.agg = agg;
  return o;
}
function MV_dateScope_() {
  var j = { table: 'DimDates', column: 'Date', dim: '[DimDates.Date (Calendar)]', datatype: 'datetime', level: 'days', title: 'Days in Date', filter: '@DATE' };
  return MV_s_(j);
}
function MV_dur_(secCtxKey) {
  return [
    MV_m_({ type: 'measure', formula: 'sum([5641E-7BD])/60', context: { '[5641E-7BD]': MV_ctx_('inhouse_call_segment__c', 'duration_seconds__c', 'Duration Seconds  C') }, datatype: 'numeric', title: 'Duration in minutes' }),
    MV_m_({ type: 'measure', formula: 'sum([BB909-8CB])', context: { '[BB909-8CB]': MV_ctx_('inhouse_call_segment__c', 'duration_seconds__c', 'Duration Seconds  C') }, datatype: 'numeric', title: 'Duration in seconds' })
  ];
}

/** key: 'A' (MVCC data), 'B' (AHT interpreters), 'C' (Short calls), 'O' (AHT operators). Returns { ds, metadata }. */
function MV_template_(key) {
  var E = 'event_log__c', I = 'inhouse_call_segment__c', AG = 'agentx__c', IN = 'interaction__c';
  var ACTIVE = ['Active', 'Terminated - Eligible'];
  var md = [];
  if (key === 'A') {
    md.push(MV_r_(MV_d_(AG, 'lan_call_center__c', 'text', 'Vendor Name')));
    md.push(MV_r_(MV_d_(E, 'Agent name', 'text', 'Agent name')));
    md.push(MV_r_(MV_d_(AG, 'E_mail__c', 'text', 'Email')));
    md.push(MV_m_(MV_d_(E, 'Assigned to', 'numeric', 'Assigned Calls', { agg: 'sum' })));
    md.push(MV_m_(MV_d_(E, 'Accepted by', 'numeric', 'Accepted Calls', { agg: 'sum' })));
    md.push(MV_m_({ type: 'measure', formula: '(sum([5F91D-348]))/(Sum([91A9E-DFB]) -(Sum([91A9E-DFB])-(Sum([5F91D-348])+Sum([B7EBE-349])+sum([CB55F-D98]))))',
      context: { '[CB55F-D98]': MV_ctx_(E, 'Assignment to', 'Assignment to'), '[B7EBE-349]': MV_ctx_(E, 'Cancelled by', 'Cancelled by'),
                 '[91A9E-DFB]': MV_ctx_(E, 'Assigned to', 'Assigned to'), '[5F91D-348]': MV_ctx_(E, 'Accepted by', 'Accepted by') },
      datatype: 'numeric', title: 'CSR' }));
    md.push(MV_m_(MV_d_(E, 'Assignment to', 'numeric', 'Timed Out', { agg: 'sum' })));
    md.push(MV_m_(MV_d_(E, 'Cancelled by', 'numeric', 'Cancelled', { agg: 'sum' })));
    md.push(MV_m_({ type: 'measure', formula: 'sum([07154-571])/(Sum([2666F-A55]) -(Sum([2666F-A55])-(Sum([C8946-488])+Sum([FE635-E6A])+sum([C8B1D-76A]))))',
      context: { '[07154-571]': MV_ctx_(E, 'Assignment to', 'Total Assignment to', 'sum'), '[C8B1D-76A]': MV_ctx_(E, 'Assignment to', 'Assignment to'),
                 '[FE635-E6A]': MV_ctx_(E, 'Cancelled by', 'Cancelled by'), '[C8946-488]': MV_ctx_(E, 'Accepted by', 'Accepted by'),
                 '[2666F-A55]': MV_ctx_(E, 'Assigned to', 'Assigned to') },
      datatype: 'numeric', title: 'Timed Out Rate' }));
    md.push(MV_m_({ type: 'measure', formula: 'sum([8E7A2-4D4])/(Sum([3405C-E2C]) -(Sum([3405C-E2C])-(Sum([157BD-34A])+Sum([8E7A2-4D4])+sum([80D2C-D8B]))))',
      context: { '[80D2C-D8B]': MV_ctx_(E, 'Assignment to', 'Assignment to'), '[8E7A2-4D4]': MV_ctx_(E, 'Cancelled by', 'Cancelled by'),
                 '[157BD-34A]': MV_ctx_(E, 'Accepted by', 'Accepted by'), '[3405C-E2C]': MV_ctx_(E, 'Assigned to', 'Assigned to') },
      datatype: 'numeric', title: 'Cancelled Rate' }));
    md.push(MV_dateScope_());
    md.push(MV_s_(MV_in_(MV_d_(AG, 'role__c', 'text', 'Agent Role'), ['Interpreter', 'Operator'])));
    md.push(MV_s_(MV_in_(MV_d_(AG, 'status__c', 'text', 'status__c'), ACTIVE)));
    return { ds: MVCC.SIS_DS_VENDOR, metadata: md };
  }
  if (key === 'B') {
    md.push(MV_r_(MV_d_(I, 'lan_call_center__c', 'text', 'Vendor Name')));
    md.push(MV_r_(MV_d_(AG, 'name', 'text', 'Agent name')));
    md.push(MV_r_(MV_d_(I, 'name', 'text', 'ICS No')));
    md.push(MV_r_(MV_d_(I, 'agent_role__c', 'text', 'Agent Role')));
    md.push(MV_r_(MV_days_(I, 'Time_Adjustment', 'Date')));
    md.push(MV_r_(MV_days_(I, 'Time_Adjustment', 'Days in Start_time')));
    md.push(MV_r_(MV_days_(I, 'End_time_Adjustment', 'Days in End_time')));
    MV_dur_().forEach(function (m) { md.push(m); });
    md.push(MV_s_(MV_in_(MV_d_(I, 'participant_mode__c', 'text', 'participant_mode__c'), ['JOIN'])));
    md.push(MV_s_(MV_in_(MV_d_(I, 'agent_role__c', 'text', 'agent_role__c'), ['Interpreter'])));
    md.push(MV_dateScope_());
    md.push(MV_s_(MV_in_(MV_d_(AG, 'role__c', 'text', 'Agent Role'), ['Interpreter'])));
    md.push(MV_s_(MV_in_(MV_d_(AG, 'status__c', 'text', 'status__c'), ACTIVE)));
    return { ds: MVCC.SIS_DS_VENDOR, metadata: md };
  }
  if (key === 'C') {
    md.push(MV_r_(MV_days_(IN, 'EST Time Adjustment Request receive time', 'Date')));
    md.push(MV_r_(MV_d_(AG, 'lan_call_center__c', 'text', 'Call Center')));
    md.push(MV_r_(MV_d_(AG, 'name', 'text', 'Agent Name')));
    md.push(MV_r_(MV_d_(IN, 'name', 'text', 'IR no')));
    md.push(MV_r_(MV_d_(I, 'duration_seconds__c', 'numeric', 'Duration in second')));
    md.push(MV_r_(MV_d_('languagex__c', 'name', 'text', 'Language Name')));
    md.push(MV_r_(MV_d_(IN, 'total_interpretation_minutes__c', 'numeric', 'Total interpretation minutes')));
    md.push(MV_r_(MV_d_(IN, 'status__c', 'text', 'Status')));
    md.push(MV_r_(MV_d_(I, 'notes__c', 'text', 'Notes')));
    md.push(MV_m_(MV_d_(I, 'id', 'text', 'No Of Short Calls', { agg: 'count' })));
    md.push(MV_s_(MV_in_(MV_d_(AG, 'role__c', 'text', 'role__c'), ['Interpreter'])));
    md.push(MV_s_(MV_d_(I, 'duration_seconds__c', 'numeric', 'duration_seconds__c', { filter: { to: '120' } })));
    md.push(MV_s_(MV_in_(MV_d_(I, 'participant_mode__c', 'text', 'participant_mode__c'), ['JOIN'])));
    md.push(MV_s_(MV_d_(I, 'notes__c', 'text', 'notes__c', { filter: { and: [{ doesntContain: 'good call' }, { doesntContain: 'success' }, { doesntContain: 'testing' },
      { doesntContain: 'accidental call' }, { doesntContain: 'good' }, { doesntContain: 'Good call.' }] } })));
    md.push(MV_s_(MV_in_(MV_d_(IN, 'total_interpretation_minutes__c', 'numeric', 'total_interpretation_minutes__c'), ['0', '1', '2'])));
    md.push(MV_dateScope_());
    md.push(MV_s_(MV_in_(MV_d_(AG, 'role__c', 'text', 'Agent Role'), ['Interpreter'])));
    md.push(MV_s_(MV_in_(MV_d_(AG, 'status__c', 'text', 'status__c'), ACTIVE)));
    return { ds: MVCC.SIS_DS_VENDOR, metadata: md };
  }
  if (key === 'O') {
    md.push(MV_r_(MV_d_(I, 'lan_call_center__c', 'text', 'Vendor Name')));
    md.push(MV_r_(MV_d_(AG, 'name', 'text', 'Agent name')));
    md.push(MV_r_(MV_d_(IN, 'name', 'text', 'Interaction')));
    md.push(MV_r_(MV_d_(I, 'name', 'text', 'ICS No')));
    md.push(MV_r_(MV_d_(AG, 'role__c', 'text', 'Agent Role')));
    md.push(MV_r_(MV_days_(I, 'Time_Adjustment', 'Date')));
    MV_dur_().forEach(function (m) { md.push(m); });
    md.push(MV_s_(MV_in_(MV_d_(I, 'participant_mode__c', 'text', 'participant_mode__c'), ['JOIN'])));
    md.push(MV_dateScope_());
    md.push(MV_s_(MV_in_({ table: I, column: 'agent_role__c', dim: '[' + I + '.agent_role__c]', datatype: 'text' }, ['Operator'])));
    return { ds: MVCC.SIS_DS_OPER, metadata: md };
  }
  throw new Error('Unknown Sisense template ' + key);
}

/** The template for one day (dates replaced). Pure. */
function MV_body_(key, ymd) {
  var t = MV_template_(key);
  t.metadata.forEach(function (it) { if (it.jaql.filter === '@DATE') it.jaql.filter = { from: ymd, to: ymd }; });
  return { datasource: t.ds, metadata: t.metadata, format: 'json', offset: 0, count: 100000, isMaskedResponse: true };
}

/* ============================== SISENSE CLIENT ============================== */
function MV_login_() {
  var props = PropertiesService.getScriptProperties();
  var u = props.getProperty(MVCC.SIS_PROP_USER), p = props.getProperty(MVCC.SIS_PROP_PASS);
  if (!u || !p) throw new Error('Script Properties ' + MVCC.SIS_PROP_USER + ' / ' + MVCC.SIS_PROP_PASS + ' are missing (they are the ones the Voyce report already uses).');
  var tried = [];
  var urls = ['/api/v1/authentication/login', '/api/auth/login'];
  for (var i = 0; i < urls.length; i++) {
    var res = UrlFetchApp.fetch(MVCC.SIS_HOST + urls[i], { method: 'post', payload: { username: u, password: p }, muteHttpExceptions: true, followRedirects: true });
    var code = res.getResponseCode(), body = res.getContentText();
    var token = '';
    try { var j = JSON.parse(body); token = j.access_token || (j.data && j.data.access_token) || ''; } catch (ignore) {}
    if (code === 200 && token) {
      CacheService.getScriptCache().put(MVCC.SIS_TOKEN_KEY, token, 1200);
      return token;
    }
    tried.push(urls[i] + ' → HTTP ' + code);
  }
  throw new Error('Sisense login failed (' + tried.join('; ') + '). Check SISENSE_USERNAME / SISENSE_PASSWORD.');
}
function MV_token_() {
  var t = CacheService.getScriptCache().get(MVCC.SIS_TOKEN_KEY);
  return t || MV_login_();
}
/** POST one JAQL body; one automatic re-login on 401. Returns { headers, values }. */
function MV_jaql_(body) {
  var attempt = 0, token = MV_token_();
  for (;;) {
    var res = UrlFetchApp.fetch(MVCC.SIS_HOST + '/api/datasources/' + encodeURIComponent(body.datasource.fullname) + '/jaql', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(body), muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 401 && attempt < MVCC.MAX_RETRY_LOGIN) { attempt++; CacheService.getScriptCache().remove(MVCC.SIS_TOKEN_KEY); token = MV_login_(); continue; }
    if (code !== 200) throw new Error('Sisense answered HTTP ' + code + ' for the ' + body.datasource.title + ' query: ' + String(res.getContentText()).slice(0, 200));
    var j;
    try { j = JSON.parse(res.getContentText()); } catch (e) { throw new Error('Sisense returned something that is not JSON.'); }
    if (!j.headers || !j.values) throw new Error('Sisense answered without data: ' + String(res.getContentText()).slice(0, 200));
    return j;
  }
}
/** Sisense result → array of objects keyed by the widget column titles. Pure. */
function MV_objects_(res) {
  var h = res.headers.map(String);
  return res.values.map(function (r) {
    var o = {};
    for (var i = 0; i < h.length; i++) { var c = r[i]; o[h[i]] = (c === null || c === undefined) ? '' : (c.data === undefined || c.data === null ? '' : c.data); }
    return o;
  });
}
/** One day from Sisense: { A, B, C, O } arrays of objects. */
function MV_fetchDay_(ymd) {
  return { A: MV_objects_(MV_jaql_(MV_body_('A', ymd))), B: MV_objects_(MV_jaql_(MV_body_('B', ymd))),
           C: MV_objects_(MV_jaql_(MV_body_('C', ymd))), O: MV_objects_(MV_jaql_(MV_body_('O', ymd))) };
}

/* ============================== ROW BUILDERS (pure) ============================== */
function MV_num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : '';
  var s = String(v === null || v === undefined ? '' : v).replace(/,/g, '').trim();
  if (s === '') return '';
  var n = Number(s);
  return isNaN(n) ? '' : n;
}
/** Text written to the sheet never becomes a formula. */
function MV_text_(s) { s = String(s === null || s === undefined ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; }
function MV_ymdOfIso_(s) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s)); return m ? m[1] : ''; }

/**
 * MVCC data rows for one day. Applies: Database filter, duplicate flags/removal.
 * @param {Object[]} rows       widget A objects
 * @param {string}   ymd
 * @param {Object}   dbNames    { lowercase interpreter name: true }
 * @param {Object}   aliases    { lowercase sisense name: lowercase database name }
 * @param {string}   dedupe     'KEEP' | 'REMOVE'
 * @returns { rows:[{day,v}], flags:[[date,type,agent,detail]], skipped, dupes }
 */
function MV_buildData_(rows, ymd, dbNames, aliases, dedupe) {
  var out = [], flags = [], seen = {}, skipped = 0, dupes = 0;
  rows.forEach(function (o) {
    var name = String(o['Agent name'] || '').trim();
    var key = name.toLowerCase();
    var dbKey = aliases[key] || key;
    var vals = [MV_num_(o['Assigned Calls']), MV_num_(o['Accepted Calls'])];
    if (!name) return;
    if (!dbNames[dbKey]) {
      skipped++;
      flags.push([ymd, 'NOT_IN_DATABASE', name, 'Not written to MVCC data: ' + vals[0] + ' assigned, ' + vals[1] + ' accepted calls. Add the agent to the Database (or an alias) to include them.']);
      return;
    }
    // sheet columns A:K = Date, Week (formula, left blank here), Vendor Name, Agent name, Assigned, Accepted, CSR, Timed Out, Cancelled, Timed Out Rate, Cancelled Rate
    var row = [ymd, '', MV_text_(o['Vendor Name']), MV_text_(name), vals[0], vals[1], MV_num_(o['CSR']), MV_num_(o['Timed Out']), MV_num_(o['Cancelled']),
               MV_num_(o['Timed Out Rate']), MV_num_(o['Cancelled Rate'])];
    if (seen[key]) {
      dupes++;
      var same = JSON.stringify(seen[key]) === JSON.stringify(row);
      flags.push([ymd, same ? 'DUPLICATE_IDENTICAL' : 'DUPLICATE_DIFFERENT', name,
        (dedupe === 'REMOVE' ? 'Second row removed. ' : 'Both rows kept: Paid hours, Talk time and Short calls are counted twice for this agent and day. ') +
        'Rows: ' + seen[key][4] + '/' + seen[key][5] + ' and ' + row[4] + '/' + row[5] + ' (assigned/accepted).']);
      if (dedupe === 'REMOVE') return;
    } else seen[key] = row;
    out.push({ day: ymd, v: row });
  });
  return { rows: out, flags: flags, skipped: skipped, dupes: dupes };
}

/**
 * AHT rows: interpreters (widget B) then operators (widget O). A:I = Vendor, Agent, ICS No, Role, Date, Start day, End day, Minutes, Seconds.
 * A segment that the dashboard shows on day D but whose own date is another day (just past midnight) is written under D,
 * the day the dashboard counts it (owner decision 2026-10-13), and listed in `moved` for the flags.
 */
function MV_buildAht_(bRows, oRows, ymd) {
  var out = [], bad = 0, moved = [];
  bRows.forEach(function (o) {
    var d = MV_ymdOfIso_(o['Date']);
    if (!d) { bad++; return; }
    if (d !== ymd) moved.push([MV_text_(o['Agent name']), MV_text_(o['ICS No']), d, MV_num_(o['Duration in seconds'])]);
    out.push({ day: ymd, ord: 0, v: [MV_text_(o['Vendor Name']), MV_text_(o['Agent name']), MV_text_(o['ICS No']), MV_text_(o['Agent Role']), ymd,
      MV_ymdOfIso_(o['Days in Start_time']), MV_ymdOfIso_(o['Days in End_time']), MV_num_(o['Duration in minutes']), MV_num_(o['Duration in seconds'])] });
  });
  oRows.forEach(function (o) {
    var d = MV_ymdOfIso_(o['Date']);
    if (!d || String(o['Agent Role']) !== 'Operator') { bad++; return; }
    if (d !== ymd) moved.push([MV_text_(o['Agent name']), MV_text_(o['ICS No']), d, MV_num_(o['Duration in seconds'])]);
    out.push({ day: ymd, ord: 1, v: [MV_text_(o['Vendor Name']), MV_text_(o['Agent name']), MV_text_(o['ICS No']), 'Operator', ymd, '', '',
      MV_num_(o['Duration in minutes']), MV_num_(o['Duration in seconds'])] });
  });
  return { rows: out, bad: bad, moved: moved };
}

/** Short calls rows (CUSTOMER_CANCELLED removed). A:J as in the workbook. */
function MV_buildShort_(rows, ymd) {
  var out = [], removed = 0, bad = 0;
  rows.forEach(function (o) {
    if (String(o['Status']).toUpperCase().replace(/[^A-Z]/g, '') === 'CUSTOMERCANCELLED') { removed++; return; }
    var d = MV_ymdOfIso_(o['Date']);
    if (d !== ymd) { bad++; return; }
    var notes = String(o['Notes'] === null || o['Notes'] === undefined ? '' : o['Notes']);
    if (notes === 'N\\A') notes = '';                                  // Sisense's "no value" marker; the workbook shows an empty cell
    out.push({ day: ymd, ord: 0, v: [d, MV_text_(o['Call Center']), MV_text_(o['Agent Name']), MV_text_(o['IR no']), MV_num_(o['Duration in second']),
      MV_text_(o['Language Name']), MV_num_(o['Total interpretation minutes']), MV_text_(o['Status']), MV_text_(notes), MV_num_(o['No Of Short Calls'])] });
  });
  return { rows: out, removed: removed, bad: bad };
}

/* ============================== RUNS ============================== */
/** Last 3 days (to yesterday), clipped to nothing else. Pure. */
function MV_backfillPlan_(today) {
  var to = MV_addDays_(today, -1), from = MV_addDays_(to, -(MVCC.BACKFILL_DAYS - 1));
  return { from: from, to: to, days: MVCC.BACKFILL_DAYS, label: MV_label_(from, to) };
}

function mvccBackfillSisense() {
  var who = MV_requireRun_();
  var plan = MV_backfillPlan_(MV_today_());
  return MV_runSisense_(plan.from, plan.to, who, 'Backfill (last ' + MVCC.BACKFILL_DAYS + ' days)');
}

function mvccLoadSisenseRange(from, to) {
  MV_requireRangeAccess_();
  var who = MV_email_();
  from = MV_ymd_(from); to = MV_ymd_(to);
  if (!from || !to) throw new Error('Give the From and To dates (yyyy-MM-dd).');
  if (from > to) throw new Error('The From date is after the To date.');
  if (to > MV_addDays_(MV_today_(), -1)) throw new Error('Reports are updated only up to yesterday (' + MV_addDays_(MV_today_(), -1) + ').');
  if (MV_days_n_(from, to) > MVCC.MAX_DAYS) throw new Error('Pick at most ' + MVCC.MAX_DAYS + ' days at a time.');
  return MV_runSisense_(from, to, who, 'Range');
}

/**
 * Pulls [from,to] day by day from Sisense and replaces those dates in MVCC data, AHT and Short calls.
 * A day with no data in widget A and widget B at all is treated as "not in Sisense yet": it is left untouched.
 * Stops starting new days after RUN_BUDGET_MS; the result then says which day to continue from (call again).
 */
function MV_runSisense_(from, to, who, mode) {
  var t0 = Date.now(), cache = CacheService.getScriptCache();
  if (cache.get(MVCC.RUN_FLAG)) throw new Error('Another MVCC load is running right now. Wait a minute and try again.');
  cache.put(MVCC.RUN_FLAG, who, MVCC.RUN_FLAG_TTL);
  var ss = null;
  try {
    ss = MV_ss_();
    var setup = MV_checkReady_(ss);                                    // Database import, headers, time zone: before anything is fetched
    var dedupe = MV_dedupeSetting_(ss);
    var db = MV_dbTable_(ss), alias = MV_aliasMap_(ss);
    var days = MV_dayList_(from, to), fetched = [], untouched = [], stoppedAt = '';
    for (var i = 0; i < days.length; i++) {
      if (fetched.length + untouched.length > 0 && Date.now() - t0 > MVCC.RUN_BUDGET_MS) { stoppedAt = days[i]; break; }
      var d = MV_fetchDay_(days[i]);
      if (!d.A.length && !d.B.length) { untouched.push(days[i]); continue; }
      fetched.push({ day: days[i], d: d });
    }
    var data = [], aht = [], shortRows = [], flags = [], perDay = [], processed = {};
    fetched.forEach(function (f) {
      var a = MV_buildData_(f.d.A, f.day, db.names, alias, dedupe);
      var b = MV_buildAht_(f.d.B, f.d.O, f.day);
      var c = MV_buildShort_(f.d.C, f.day);
      if (b.bad) flags.push([f.day, 'AHT_ROW_SKIPPED', '', b.bad + ' AHT rows had no date or a role other than Operator in the operator report and were not written.']);
      b.moved.forEach(function (m) { flags.push([f.day, 'AHT_OTHER_DATE', m[0], m[1] + ' (' + m[3] + ' s) is dated ' + m[2] + ' in Sisense; counted under ' + f.day + ', the day the dashboard shows it.']); });
      if (c.bad) flags.push([f.day, 'SHORT_ROW_SKIPPED', '', c.bad + ' Short call rows had a different date than requested and were not written.']);
      data = data.concat(a.rows); aht = aht.concat(b.rows); shortRows = shortRows.concat(c.rows); flags = flags.concat(a.flags);
      processed[f.day] = 1;
      perDay.push({ day: f.day, mvccRows: a.rows.length, notInDatabase: a.skipped, duplicates: a.dupes, ahtRows: b.rows.length, shortCalls: c.rows.length, shortCallsCancelledRemoved: c.removed });
    });
    var stats = { data: null, aht: null, short: null };
    if (fetched.length) {
      var repair = MV_ensureFormulas_(ss);                            // formulas first: a setting problem stops the run before any row is written
      stats.data = MV_replaceDates_(ss.getSheetByName(MVCC.DATA), MVCC.DATA_LOAD_COLS, 1, data, processed, MV_dataKeep_, [2]);   // B = Week, row-1 formula
      stats.aht = MV_replaceDates_(ss.getSheetByName(MVCC.AHT), MVCC.AHT_COLS, 5, aht, processed, MV_ahtKeep_);
      stats.short = MV_replaceDates_(ss.getSheetByName(MVCC.SHORT), MVCC.SHORT_COLS, 1, shortRows, processed, MV_shortKeep_);
      SpreadsheetApp.flush();
      MV_replaceFlags_(ss, flags, processed);
      var chk = MV_postCheck_(ss, processed);
      var secs = Math.round((Date.now() - t0) / 1000);
      var warn = [];
      if (chk.errorRows) warn.push(chk.errorRows + ' MVCC rows show #N/A in the lookup columns (' + chk.errorAgents.slice(0, 5).join(', ') + ').');
      if (untouched.length) warn.push('No data yet in Sisense for ' + untouched.join(', ') + ' (left unchanged).');
      var skippedTotal = perDay.reduce(function (s, p) { return s + p.notInDatabase; }, 0), dupTotal = perDay.reduce(function (s, p) { return s + p.duplicates; }, 0);
      if (skippedTotal) warn.push(skippedTotal + ' agent-day rows are not in the Database and were not written (see _Flags).');
      if (dupTotal) warn.push(dupTotal + ' duplicate agent-day rows ' + (dedupe === 'REMOVE' ? 'were reduced to one' : 'were kept (counted twice)') + ' (see _Flags).');
      var status = (chk.errorRows || untouched.length) ? 'CHECK' : 'OK';
      MV_log_(ss, [new Date(), who, from, to, mode, data.length, aht.length, shortRows.length, flags.length, secs, status, warn.join(' ') + (repair.length ? ' Repaired: ' + repair.join(', ') + '.' : '')]);
      MV_control_(ss, { B2: new Date(), B3: from + ' → ' + (stoppedAt ? MV_addDays_(stoppedAt, -1) : to), B4: status + (warn.length ? ': ' + warn.join(' ') : ''),
                        B5: stats.data.total, B6: stats.aht.total, B7: stats.short.total, B8: who });
      return { ok: true, from: from, to: to, mode: mode, processed: Object.keys(processed).sort(), untouched: untouched, perDay: perDay,
               totals: { mvccRows: data.length, ahtRows: aht.length, shortCalls: shortRows.length, flags: flags.length },
               sheetRows: { mvcc: stats.data.total, aht: stats.aht.total, short: stats.short.total },
               status: status, warnings: warn, continueFrom: stoppedAt || '', seconds: secs };
    }
    MV_log_(ss, [new Date(), who, from, to, mode, 0, 0, 0, 0, Math.round((Date.now() - t0) / 1000), 'CHECK', 'Sisense returned no data for ' + untouched.join(', ') + '. Nothing was changed.']);
    return { ok: true, from: from, to: to, mode: mode, processed: [], untouched: untouched, perDay: [], status: 'CHECK',
             warnings: ['Sisense returned no data for ' + untouched.join(', ') + '. Nothing was changed.'], continueFrom: stoppedAt || '' };
  } catch (e) {
    try { MV_log_(ss || MV_ss_(), [new Date(), who, from, to, mode, '', '', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    cache.remove(MVCC.RUN_FLAG);
  }
}

/* ============================== PAID HOURS (NICE) ============================== */
function mvccStartPaidHours() {
  var who = MV_requireRun_();
  MV_ss_();
  var plan = MV_paidPlan_(MV_today_());
  var runId = Utilities.getUuid();
  plan.runId = runId; plan.by = who;
  CacheService.getScriptCache().put('MVCC_RUN_' + runId, JSON.stringify(plan), MVCC.RUN_TTL);
  return { ok: true, runId: runId, from: plan.from, to: plan.to, days: plan.days, label: plan.label,
           jobs: [MV_niceJob_(plan, true), MV_niceJob_(plan, false)] };
}

/** Month of yesterday: 1st of that month → yesterday (so on the 1st it reloads the whole previous month). Pure. */
function MV_paidPlan_(today) {
  var to = MV_addDays_(today, -1), from = to.slice(0, 8) + '01';
  return { ok: true, from: from, to: to, days: MV_days_n_(from, to), niceFrom: MV_niceDate_(from), niceTo: MV_niceDate_(to), label: MV_label_(from, to) };
}

/** Time Utilization report, MU set "6 FG", absolute dates, details by day + agent + activity (verified 2026-10-13). */
function MV_niceJob_(plan, schedules) {
  var codes = (schedules ? MVCC.NICE_CODES_SCHED : MVCC.NICE_CODES_ACT).map(function (c) { return { id: c.id, oid: c.oid, operator: 'NONE', hours: '0', minutes: '0' }; });
  return {
    workflow: 'nice-report',
    report: schedules ? 'MVCC Paid Hours (Schedules)' : 'MVCC Paid Hours (Agent Activity)',
    formUrl: '/supv/reportAction.mvc?selectedTabAction=/TimeUtilizationReportMain.mvc&selectedTabOverride=/generateReportWizard.mvc',
    formName: 'TimeUtilizationReportForm',
    steps: [
      ['reportName', schedules ? 'MVCC Paid Hours - Schedules' : 'MVCC Paid Hours - Agent Activity'],
      ['reportFormatTypeOid', 'CSV'],
      ['reportTypeParam', 'MU_SET', 900],
      ['viewIdParam', MVCC.NICE_VIEW_OID, 300],
      ['viewNameParam', MVCC.NICE_VIEW_OID, 300],
      ['isAbsolute', 'true', 300],
      ['stAbsDate', plan.niceFrom], ['endAbsDate', plan.niceTo],
      ['isScheduleData', schedules ? 'true' : 'false', 600],
      ['inclDetailsPerDay', true], ['inclDetailsPerAgent', true], ['inclDetailsPerActivity', true],
      { op: 'set', name: 'activityCodes', value: JSON.stringify(codes) },
      { op: 'call', fn: 'processSelectedCodes', args: [] }
    ],
    verify: ['reportFormatTypeOid', 'reportTypeParam', 'viewIdParam', 'isAbsolute', 'stAbsDate', 'endAbsDate', 'isScheduleData'],
    // View Reports shows the report TYPE (not the name typed in the form): verified live 2026-10-13 ("Time Utilization | 6 FG | 10/1/26 | 10/12/26").
    // The 2nd job only looks at reports created after it started, so the two reports cannot be mixed up.
    match: { name: 'Time Utilization', subject: '6 FG', start: plan.niceFrom, end: plan.niceTo },
    format: 'CSV',
    expectHeader: 'Date,Entity ID,Entity Name,Agent ID,Agent Name',
    timeoutSec: 420
  };
}

/** The page passes both CSVs the extension downloaded (Schedules first, Agent Activity second). */
function mvccSavePaidHours(runId, csvSchedules, csvActivity, meta) {
  var who = MV_requireRun_(), t0 = Date.now();
  var plan = MV_takePlan_(runId);
  meta = meta || {};
  var cache = CacheService.getScriptCache();
  if (cache.get(MVCC.RUN_FLAG)) throw new Error('Another MVCC load is running right now. Wait a minute and press the button again.');
  cache.put(MVCC.RUN_FLAG, who, MVCC.RUN_FLAG_TTL);
  var ss = null;
  try {
    ss = MV_ss_();
    var r1 = MV_paidRows_(csvSchedules, plan.from, plan.to, 'Schedules'), r2 = MV_paidRows_(csvActivity, plan.from, plan.to, 'Agent Activity');
    var rows = r1.rows.concat(r2.rows);
    if (!rows.length) throw new Error('NICE returned no rows for ' + plan.label + '. Nothing was changed.');
    MV_ensureFormulas_(ss);
    var days = {};
    MV_dayList_(plan.from, plan.to).forEach(function (d) { days[d] = 1; });          // the whole period is replaced (owner: Paid Hours are replaced each run)
    var stats = MV_replaceDates_(ss.getSheetByName(MVCC.PAID), MVCC.PAID_COLS, 1, rows, days, MV_paidKeep_);
    SpreadsheetApp.flush();
    var secs = Math.round((Date.now() - t0) / 1000);
    var hours = rows.reduce(function (s, r) { return s + (typeof r.v[7] === 'number' ? r.v[7] : 0); }, 0);
    MV_log_(ss, [new Date(), who, plan.from, plan.to, 'Paid Hours (NICE)', '', '', rows.length, 0, secs + (meta.niceSeconds ? ' (+' + meta.niceSeconds + ' in NICE)' : ''), 'OK',
      'Schedules ' + r1.rows.length + ' rows, Agent Activity ' + r2.rows.length + ' rows, ' + Math.round(hours * 100) / 100 + ' h.' + (meta.reportOid ? ' NICE reports ' + meta.reportOid + '.' : '')]);
    MV_control_(ss, { B9: new Date(), B10: plan.label + ' (' + plan.from + ' → ' + plan.to + ')', B11: stats.total, B12: who });
    return { ok: true, from: plan.from, to: plan.to, label: plan.label, schedulesRows: r1.rows.length, activityRows: r2.rows.length,
             hours: Math.round(hours * 100) / 100, kept: stats.kept, total: stats.total, seconds: secs };
  } catch (e) {
    try { MV_log_(ss || MV_ss_(), [new Date(), who, plan.from, plan.to, 'Paid Hours (NICE)', '', '', '', '', Math.round((Date.now() - t0) / 1000), 'FAILED', String(e.message || e)]); } catch (ignore) {}
    throw e;
  } finally {
    cache.remove(MVCC.RUN_FLAG);
  }
}

function mvccReportRunFailure(runId, stage, message) {
  var who = MV_requireRun_();
  var plan = null;
  try { var raw = CacheService.getScriptCache().get('MVCC_RUN_' + String(runId || '')); plan = raw ? JSON.parse(raw) : null; } catch (ignore) {}
  try {
    MV_log_(MV_ss_(), [new Date(), who, plan ? plan.from : '', plan ? plan.to : '', 'Paid Hours (NICE)', '', '', '', '', '', 'FAILED',
      (stage ? '[' + String(stage).slice(0, 60) + '] ' : '') + String(message || '').slice(0, 500)]);
  } catch (ignore) {}
  return { ok: true };
}

/** NICE CSV (Date, Entity ID, Entity Name, Agent ID, Agent Name, <activity>, Length, Percent) → sheet rows A:I. */
function MV_paidRows_(csv, from, to, label) {
  var parsed = MV_parseCsv_(csv, label);
  var h = parsed.header.map(MV_norm_);
  var want = ['date', 'entityid', 'entityname', 'agentid', 'agentname'];
  for (var k = 0; k < want.length; k++) if (h[k] !== want[k]) throw new Error('The NICE ' + label + ' report does not have the expected columns (column ' + (k + 1) + ' is "' + parsed.header[k] + '"). Nothing was changed.');
  if (!/activit/.test(h[5] || '') || h[6].indexOf('length') !== 0 || h[7] !== 'percent' || parsed.header.length !== 8)
    throw new Error('The NICE ' + label + ' report does not have the expected columns (Date … Agent Name, activity, Length, Percent). Nothing was changed.');
  var out = [];
  parsed.rows.forEach(function (r, i) {
    var line = i + 2;
    if (r.length === 1 && String(r[0]).trim() === '') return;
    if (r.length !== 8) throw new Error('NICE ' + label + ' line ' + line + ' has ' + r.length + ' columns (expected 8). Nothing was changed.');
    var ymd = MV_ymdFromNice_(r[0], line, label);
    if (ymd < from || ymd > to) throw new Error('NICE ' + label + ' line ' + line + ' is dated ' + r[0] + ', outside ' + from + ' → ' + to + '. Nothing was changed.');
    var mins = MV_minutes_(r[6], line, label);
    out.push({ day: ymd, ord: label === 'Schedules' ? 0 : 1,
      v: [ymd, MV_numStrict_(r[1], line, label, 'Entity ID'), MV_text_(r[2]), MV_numStrict_(r[3], line, label, 'Agent ID'), MV_text_(r[4]), MV_text_(r[5]),
          mins / 1440, mins / 60, MV_pct_(r[7])] });
  });
  return { rows: out };
}
function MV_minutes_(s, line, label) {
  var m = /^\s*(\d+):(\d{2})\s*$/.exec(String(s));
  if (!m) throw new Error('NICE ' + label + ' line ' + line + ': unreadable Length "' + s + '". Nothing was changed.');
  return Number(m[1]) * 60 + Number(m[2]);
}
function MV_numStrict_(s, line, label, col) {
  s = String(s).replace(/,/g, '').trim();
  if (s === '') return '';
  var n = Number(s);
  if (isNaN(n)) throw new Error('NICE ' + label + ' line ' + line + ': "' + col + '" is not a number ("' + s + '"). Nothing was changed.');
  return n;
}
function MV_pct_(s) {
  s = String(s).trim();
  var m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? Math.round(Number(m[1]) * 100) / 10000 : MV_text_(s);
}
/** NICE CSV date: 2026-10-01 (what the Time Utilization CSV sends, seen live 2026-10-13) or M/D/YY or M/D/YYYY. */
function MV_ymdFromNice_(s, line, label) {
  var t = String(s).trim(), y, mo, d, m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
    if (!m) throw new Error('NICE ' + label + ' line ' + line + ': unreadable date "' + s + '". Nothing was changed.');
    y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); mo = Number(m[1]); d = Number(m[2]);
  }
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > dim) throw new Error('NICE ' + label + ' line ' + line + ': impossible date "' + s + '". Nothing was changed.');
  return y + '-' + MV_pad_(mo) + '-' + MV_pad_(d);
}
/** RFC-4180 CSV → { header, rows }. Pure. */
function MV_parseCsv_(text, label) {
  text = String(text === null || text === undefined ? '' : text).replace(/^﻿/, '');
  if (!text.trim()) throw new Error('The NICE ' + label + ' download was empty.');
  if (/^\s*</.test(text)) throw new Error('NICE returned a web page instead of the ' + label + ' CSV (the session may have ended). Nothing was changed.');
  var out = [], row = [], f = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (q) { if (ch === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text.charAt(i + 1) === '\n') i++; row.push(f); out.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  out = out.filter(function (r) { return !(r.length === 1 && String(r[0]).trim() === ''); });
  if (!out.length) throw new Error('The NICE ' + label + ' download had no header row.');
  return { header: out[0].map(function (h) { return String(h).trim(); }), rows: out.slice(1) };
}

/* ============================== WRITING (replace by date) ============================== */
function MV_dataKeep_(v) { return { ord: 0 }; }
function MV_ahtKeep_(v) { return { ord: (v[3] === 'Operator' || v[3] === '') ? 1 : 0 }; }
function MV_shortKeep_(v) { return { ord: 0 }; }
function MV_paidKeep_(v) { return { ord: 0 }; }

/**
 * Replaces the days in `days` ({ymd:1}) with `rows` ([{day, ord, v}]); every other day stays.
 * Reads columns 1..ncols; writes and clears them except the `skip` columns (1-based), which hold row-1 array formulas.
 * Rows end up sorted by day, then ord (stable). `dateCol` is the 1-based column that holds the date.
 * Fast path: when the sheet is already in date order and every row of a later day is replaced, only the tail is rewritten.
 */
function MV_replaceDates_(sh, ncols, dateCol, rows, days, keepInfo, skip) {
  var segs = MV_segments_(ncols, skip || []);
  var last = MV_lastRow_(sh, dateCol), kept = [], minDay = Object.keys(days).sort()[0];
  var existing = last >= 2 ? sh.getRange(2, 1, last - 1, ncols).getValues() : [];
  var sorted = true, prev = '', keptAfterMin = false;
  existing.forEach(function (v, i) {
    var d = MV_ymdOf_(v[dateCol - 1]);
    if (!d) return;
    if (prev && d < prev) sorted = false;
    prev = d;
    if (days[d]) return;
    if (minDay && d > minDay) keptAfterMin = true;
    var info = keepInfo(v);
    kept.push({ day: d, ord: info.ord, v: v, idx: i });
  });
  var all, startRow;
  if (sorted && !keptAfterMin) {                                    // fast path: kept rows are all before the replaced days
    startRow = (kept.length ? kept[kept.length - 1].idx + 3 : 2);   // first row after the last kept row
    all = rows.slice().sort(MV_cmpRows_);
  } else {
    all = kept.concat(rows).sort(MV_cmpRows_);
    startRow = 2;
  }
  var total = (startRow - 2) + all.length;
  if (total * Math.max(ncols, 1) > MVCC.CELL_WARN) throw new Error(sh.getName() + ' would hold ' + total + ' rows (too close to the Google Sheets 10,000,000 cell limit). Archive an old month first. Nothing was changed.');
  if (last >= startRow) segs.forEach(function (g) { sh.getRange(startRow, g[0], last - startRow + 1, g[1]).clearContent(); });
  var need = startRow + all.length;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  for (var s = 0; s < all.length; s += MVCC.WRITE_CHUNK) {
    var part = all.slice(s, s + MVCC.WRITE_CHUNK).map(function (r) { return MV_toCells_(r.v); });
    segs.forEach(function (g) {
      sh.getRange(startRow + s, g[0], part.length, g[1]).setValues(part.map(function (v) { return v.slice(g[0] - 1, g[0] - 1 + g[1]); }));
    });
  }
  if (all.length) MV_formatDates_(sh, dateCol, startRow, all.length);
  return { kept: kept.length, total: total };
}
/** Contiguous column blocks of 1..ncols without the skipped columns: [[firstCol, count], ...]. Pure. */
function MV_segments_(ncols, skip) {
  var out = [], start = 0;
  for (var c = 1; c <= ncols + 1; c++) {
    var use = c <= ncols && skip.indexOf(c) < 0;
    if (use && !start) start = c;
    if (!use && start) { out.push([start, c - start]); start = 0; }
  }
  return out;
}
function MV_cmpRows_(a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : (a.ord || 0) - (b.ord || 0); }
/** Strings 'yyyy-MM-dd' that stand for dates become real dates; everything else is written as it is. */
function MV_toCells_(v) {
  return v.map(function (x) {
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return MV_dateOf_(x);
    if (typeof x === 'string' && x.charAt(0) === "'") return x;                 // guarded text keeps its apostrophe (the sheet shows it as text)
    return x;
  });
}
function MV_formatDates_(sh, dateCol, startRow, n) {
  try {
    var name = sh.getName();
    var cols = name === MVCC.AHT ? [5, 6, 7] : [dateCol];
    cols.forEach(function (c) {                                      // same date look as the existing rows (row 2), e.g. "11-Oct"
      var f = sh.getMaxRows() >= 2 ? String(sh.getRange(2, c).getNumberFormat() || '') : '';
      if (!/[dmy]/i.test(f)) f = 'm/d/yyyy';
      sh.getRange(startRow, c, n, 1).setNumberFormat(f);
    });
    if (name === MVCC.PAID) { sh.getRange(startRow, 7, n, 1).setNumberFormat('[h]:mm'); sh.getRange(startRow, 8, n, 1).setNumberFormat('0.00'); sh.getRange(startRow, 9, n, 1).setNumberFormat('0.00%'); }
  } catch (ignore) {}
}
function MV_lastRow_(sh, col) {
  var max = sh.getMaxRows();
  if (max < 2) return 1;
  var vals = sh.getRange(2, col, max - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) if (vals[i][0] !== '' && vals[i][0] !== null) return i + 2;
  return 1;
}

/* ============================== FORMULAS (MVCC data B, L:Z: one formula in row 1 per column) ============================== */
/**
 * One ARRAYFORMULA per column in row 1: it shows the header and fills every data row, so nothing is written per row and
 * new rows are covered automatically. Same logic as the validated Phase 1 row formulas. The SUMIFS columns use
 * SUMIF over "key|date" (SUMIFS does not expand inside ARRAYFORMULA). Database letters come from its header row. Pure.
 */
function MV_arrayFormulas_(m) {
  var Db = function (c) { return 'Database!' + c + ':' + c; };
  var al = 'IFERROR(XLOOKUP(D2:D,Aliases!A:A,Aliases!B:B),D2:D)';
  var idxSup1 = MV_colNum_(m.sup) - MV_colNum_(m.nice) + 1, idxSup2 = MV_colNum_(m.sup) - MV_colNum_(m.icol) + 1, idxLg = MV_colNum_(m.lg) - MV_colNum_(m.nname) + 1;
  var af = function (header, expr) { return '=ARRAYFORMULA({"' + header + '";IF(A2:A="",,' + expr + ')})'; };
  return {
    B: af('Week', 'IF(DAY(A2:A)>21,"week 4",IF(DAY(A2:A)>14,"week 3",IF(DAY(A2:A)>7,"week 2","week 1")))'),
    L: af('Abandond', 'E2:E-F2:F'),
    M: af('Paid hour', "SUMIF('Paid Hours'!D2:D&\"|\"&'Paid Hours'!A2:A,Q2:Q&\"|\"&A2:A,'Paid Hours'!H2:H)"),
    N: af('Talk time', 'SUMIF(AHT!B2:B&"|"&AHT!E2:E,D2:D&"|"&A2:A,AHT!H2:H)/60'),
    O: af('Short calls', "SUMIF('Short calls'!C2:C&\"|\"&'Short calls'!A2:A,D2:D&\"|\"&A2:A,'Short calls'!J2:J)"),
    P: af('THT', 'N2:N*F2:F'),
    Q: af('Nice ID', 'XLOOKUP(Z2:Z,' + Db(m.email) + ',' + Db(m.nice) + ')'),
    R: af('Interpreter ID', 'XLOOKUP(' + al + ',' + Db(m.icol) + ',' + Db(m.nice) + ')'),
    S: af('Interpreter Name', 'XLOOKUP(' + al + ',' + Db(m.icol) + ',' + Db(m.nname) + ')'),
    T: af('TL', 'IFERROR(VLOOKUP(R2:R,Database!' + m.nice + ':' + m.sup + ',' + idxSup1 + ',0),VLOOKUP(' + al + ',Database!' + m.icol + ':' + m.sup + ',' + idxSup2 + ',0))'),
    U: af('Seat', 'XLOOKUP(R2:R,' + Db(m.nice) + ',' + Db(m.seat) + ')'),
    V: af('Langauge', 'XLOOKUP(S2:S,' + Db(m.nname) + ',' + Db(m.seatLang) + ')'),
    W: af('LOB', 'IF(VLOOKUP(S2:S,Database!' + m.nname + ':' + m.lg + ',' + idxLg + ',0)="PENs","operator","VRI")'),
    X: af('Language Group', 'XLOOKUP(S2:S,' + Db(m.nname) + ',' + Db(m.lg) + ')'),
    Y: af('SDACMs', 'XLOOKUP(R2:R,' + Db(m.nice) + ',' + Db(m.mgr) + ')'),
    Z: af('Email Address', 'XLOOKUP(R2:R,' + Db(m.nice) + ',' + Db(m.email) + ')')
  };
}

/**
 * Self-repair, run before every write: tabs exist, Database columns found, and every row-1 formula of MVCC data is the
 * expected one. A column whose row-1 formula is missing or different (e.g. the old per-row formulas) is cleared below
 * row 1 and gets its formula back; a #REF! in row 1 (something typed in the column) is cleared. Returns what it fixed.
 */
function MV_ensureFormulas_(ss) {
  var fixed = [];
  [MVCC.DATA, MVCC.AHT, MVCC.SHORT, MVCC.PAID, MVCC.DB, MVCC.ALIAS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('The tab "' + n + '" is missing in the MVCC spreadsheet. Nothing was changed.');
  });
  if (!ss.getSheetByName(MVCC.CONTROL)) { MV_controlLayout_(ss.insertSheet(MVCC.CONTROL)); fixed.push('_Control re-created'); }
  if (!ss.getSheetByName(MVCC.LOG)) { MV_logLayout_(ss.insertSheet(MVCC.LOG)); fixed.push('_Load Log re-created'); }
  if (!ss.getSheetByName(MVCC.FLAGS)) { MV_flagsLayout_(ss.insertSheet(MVCC.FLAGS)); fixed.push('_Flags re-created'); }
  var m = MV_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  var ctl = ss.getSheetByName(MVCC.CONTROL), ck = MV_checksumFormula_();
  if (ctl.getRange(MVCC.CHECKSUM_ROW, 2).getFormula() !== ck) {
    ctl.getRange(MVCC.CHECKSUM_ROW, 1).setValue('Lookup checksum (changes when a Database edit changes a lookup; used by the dashboard)');
    ctl.getRange(MVCC.CHECKSUM_ROW, 2).setFormula(ck);
    fixed.push('_Control checksum written');
  }
  var sh = ss.getSheetByName(MVCC.DATA), f = MV_arrayFormulas_(m.cols), maxR = sh.getMaxRows();
  if (sh.getMaxColumns() < MVCC.DATA_TOTAL_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), MVCC.DATA_TOTAL_COLS - sh.getMaxColumns());
  var cols = Object.keys(f), heads = sh.getRange(1, 1, 1, MVCC.DATA_TOTAL_COLS).getFormulas()[0], changed = [];
  cols.forEach(function (col) {
    if (heads[MV_colNum_(col) - 1] === f[col]) return;
    if (maxR > 1) sh.getRange(col + '2:' + col + maxR).clearContent();
    sh.getRange(col + '1').setFormula(f[col]);
    changed.push(col);
  });
  if (changed.length) { fixed.push('row-1 formulas written in ' + changed.join(',')); SpreadsheetApp.flush(); }
  var shown = sh.getRange(1, 1, 1, MVCC.DATA_TOTAL_COLS).getDisplayValues()[0];
  cols.forEach(function (col) {
    if (String(shown[MV_colNum_(col) - 1]).indexOf('#REF') === 0 && maxR > 1) {
      sh.getRange(col + '2:' + col + maxR).clearContent();
      fixed.push(col + ' cleared below row 1 (something was typed there)');
    }
  });
  return fixed;
}

function MV_checksumFormula_() { return "=SUMPRODUCT(LEN('" + MVCC.DATA + "'!Q2:Z))"; }

/* ============================== DATABASE / ALIASES ============================== */
function MV_dbStatus_(ss, wait) {
  var db = ss.getSheetByName(MVCC.DB);
  if (!db) return { ok: false, message: 'The Database tab is missing.' };
  var tries = wait ? 6 : 1;
  for (var i = 0; i < tries; i++) {
    var head = db.getRange(1, 1, 1, Math.min(40, db.getMaxColumns())).getValues()[0];
    var a1 = String(db.getRange('A1').getDisplayValue() || '');
    if (/^#(REF|N\/A|ERROR)/i.test(a1)) return { ok: false, message: 'The Database import is not working (' + a1 + '). Open the spreadsheet, click Database!A1 and press "Allow access" once.' };
    if (head.filter(function (h) { return String(h).trim() !== ''; }).length >= 5) return { ok: true, header: head.map(String), rows: Math.max(0, db.getLastRow() - 1) };
    if (i < tries - 1) { Utilities.sleep(2500); SpreadsheetApp.flush(); }
  }
  return { ok: false, message: 'The Database tab shows no data (still loading, or "Allow access" is needed on Database!A1).' };
}
function MV_dbColumns_(ss) {
  var st = MV_dbStatus_(ss, true);
  if (!st.ok) return { ok: false, message: st.message };
  var cols = {}, missing = [];
  Object.keys(MVCC.DB_COLS).forEach(function (k) {
    var want = MV_norm_(MVCC.DB_COLS[k]), idx = -1;
    for (var j = 0; j < st.header.length; j++) if (MV_norm_(st.header[j]) === want) { idx = j; break; }
    if (idx < 0) missing.push(MVCC.DB_COLS[k]); else cols[k] = MV_col_(idx + 1);
  });
  if (missing.length) return { ok: false, message: 'The Database tab has no column named: ' + missing.join(', ') + '. Check the source tab name (Database!A1 IMPORTRANGE). Nothing was changed.' };
  if (MV_colNum_(cols.sup) <= MV_colNum_(cols.nice) || MV_colNum_(cols.sup) <= MV_colNum_(cols.icol) || MV_colNum_(cols.lg) <= MV_colNum_(cols.nname))
    return { ok: false, message: 'The Database column order changed (Supervisor must be after Nice ID / Interpreter name, Language Group after Name on Nice). Nothing was changed.' };
  return { ok: true, cols: cols };
}
/** { names: {lowercase interpreter name:true} } from the Database tab. */
function MV_dbTable_(ss) {
  var m = MV_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  var db = ss.getSheetByName(MVCC.DB), last = db.getLastRow();
  var c = MV_colNum_(m.cols.icol);
  var vals = last >= 2 ? db.getRange(2, c, last - 1, 1).getValues() : [];
  var names = {};
  vals.forEach(function (r) { var k = String(r[0] === null || r[0] === undefined ? '' : r[0]).toLowerCase(); if (k) names[k] = true; });
  return { names: names };
}
/** Aliases tab: A = name in Sisense, B = name in the Database → { lowercase A: lowercase B }. */
function MV_aliasMap_(ss) {
  var sh = ss.getSheetByName(MVCC.ALIAS), out = {};
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    var a = String(r[0] || '').toLowerCase(), b = String(r[1] || '').toLowerCase();
    if (a && b) out[a] = b;
  });
  return out;
}

/* ============================== CHECKS / CONTROL / LOG / FLAGS ============================== */
/**
 * The spreadsheet's stored time zone can differ from what File > Settings shows (a file created through the API keeps
 * a default value until the setting is saved explicitly). Dates are written as midnight New York, so the stored value
 * must really be America/New_York. Setup writes it explicitly; it does not change any date already in the sheet.
 */
function MV_fixTimeZone_(ss) {
  var before = ss.getSpreadsheetTimeZone();
  if (before === MVCC.TZ) return 'Time zone OK (' + MVCC.TZ + ').';
  ss.setSpreadsheetTimeZone(MVCC.TZ);
  SpreadsheetApp.flush();
  var after = ss.getSpreadsheetTimeZone();
  if (after !== MVCC.TZ) throw new Error('Could not set the spreadsheet time zone to ' + MVCC.TZ + ' (it reads ' + after + '). Nothing else was changed.');
  return 'Time zone set to ' + MVCC.TZ + ' (the stored value was ' + before + ').';
}
function MV_checkReady_(ss) {
  if (ss.getSpreadsheetTimeZone() !== MVCC.TZ) throw new Error('The MVCC spreadsheet time zone reads ' + ss.getSpreadsheetTimeZone() + ' instead of ' + MVCC.TZ + '. Run setupMvccSheet once (it sets it). Nothing was changed.');
  MV_ensureFormulas_(ss);
  return true;
}
/** After a load: do the lookup columns resolve for the loaded days? */
function MV_postCheck_(ss, days) {
  var sh = ss.getSheetByName(MVCC.DATA), last = MV_lastRow_(sh, 1), errorRows = 0, errorAgents = {};
  if (last < 2) return { errorRows: 0, errorAgents: [] };
  var a = sh.getRange(2, 1, last - 1, 1).getValues(), d = sh.getRange(2, 4, last - 1, 1).getValues(), r = sh.getRange(2, 18, last - 1, 1).getDisplayValues();
  for (var i = 0; i < a.length; i++) {
    var day = MV_ymdOf_(a[i][0]);
    if (!day || !days[day]) continue;
    if (/^#/.test(String(r[i][0]))) { errorRows++; errorAgents[d[i][0]] = 1; }
  }
  return { errorRows: errorRows, errorAgents: Object.keys(errorAgents) };
}

function MV_dedupeSetting_(ss) {
  var c = ss.getSheetByName(MVCC.CONTROL);
  var v = c ? String(c.getRange(MVCC.DEDUPE_CELL).getValue() || '').trim().toUpperCase() : '';
  return v === 'REMOVE' ? 'REMOVE' : 'KEEP';
}
function MV_controlLayout_(c) {
  c.getRange('A1:B1').setValues([['Status', 'Value']]).setFontWeight('bold');
  c.getRange('A2:A12').setValues([['Last Sisense load'], ['Last Sisense period'], ['Last Sisense status'], ['Rows in MVCC data'], ['Rows in AHT'], ['Rows in Short calls'],
    ['Last Sisense load by'], ['Last Paid Hours load'], ['Last Paid Hours period'], ['Rows in Paid Hours'], ['Last Paid Hours load by']]);
  c.getRange('A13').setValue('Settings').setFontWeight('bold');
  c.getRange('A14').setValue('Duplicate agent rows on the same day: KEEP (as Sisense returns them) or REMOVE (keep the first)');
  if (!String(c.getRange(MVCC.DEDUPE_CELL).getValue() || '').trim()) c.getRange(MVCC.DEDUPE_CELL).setValue('KEEP');
  c.setColumnWidth(1, 420);
}
function MV_logLayout_(l) {
  l.getRange(1, 1, 1, 12).setValues([['Run at', 'By', 'From', 'To', 'Mode', 'MVCC rows', 'AHT rows', 'Short call / Paid rows', 'Flags', 'Seconds', 'Status', 'Message']]).setFontWeight('bold');
  l.setFrozenRows(1);
}
function MV_flagsLayout_(f) {
  f.getRange(1, 1, 1, 5).setValues([['Date', 'Type', 'Agent', 'Detail', 'Raised at']]).setFontWeight('bold');
  f.setFrozenRows(1);
}
function MV_control_(ss, map) { var c = ss.getSheetByName(MVCC.CONTROL); if (c) Object.keys(map).forEach(function (a1) { c.getRange(a1).setValue(map[a1]); }); }
function MV_log_(ss, row) { var l = ss.getSheetByName(MVCC.LOG); if (l) l.appendRow(row.map(function (v) { return typeof v === 'string' ? MV_text_(v) : v; })); }
/** Replaces the flags of the processed days with the new ones (flags of other days stay). */
function MV_replaceFlags_(ss, flags, days) {
  var f = ss.getSheetByName(MVCC.FLAGS);
  if (!f) return;
  var last = f.getLastRow(), keep = [];
  if (last >= 2) f.getRange(2, 1, last - 1, 5).getValues().forEach(function (r) { var d = MV_ymdOf_(r[0]) || String(r[0]); if (!days[d]) keep.push(r); });
  var now = new Date();
  var all = keep.concat(flags.map(function (x) { return [x[0], x[1], MV_text_(x[2]), MV_text_(x[3]), now]; }));
  if (last >= 2) f.getRange(2, 1, last - 1, 5).clearContent();
  if (all.length) {
    if (f.getMaxRows() < all.length + 1) f.insertRowsAfter(f.getMaxRows(), all.length + 1 - f.getMaxRows());
    f.getRange(2, 1, all.length, 5).setValues(all);
  }
}

/* ============================== SETUP / REPAIR / TESTS (editor) ============================== */
function setupMvccSheet() {
  requireSetupAccess_();
  var ss = MV_ss_();
  var tzNote = MV_fixTimeZone_(ss);
  [MVCC.DATA, MVCC.AHT, MVCC.SHORT, MVCC.PAID, MVCC.DB, MVCC.ALIAS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('The tab "' + n + '" is missing. The spreadsheet must be the "MVCC Data" workbook.');
  });
  var c = ss.getSheetByName(MVCC.CONTROL) || ss.insertSheet(MVCC.CONTROL);
  MV_controlLayout_(c);
  var l = ss.getSheetByName(MVCC.LOG) || ss.insertSheet(MVCC.LOG);
  if (!l.getRange('A1').getValue()) MV_logLayout_(l);
  var f = ss.getSheetByName(MVCC.FLAGS) || ss.insertSheet(MVCC.FLAGS);
  if (!f.getRange('A1').getValue()) MV_flagsLayout_(f);
  var m = MV_dbColumns_(ss);
  if (!m.ok) throw new Error(m.message);
  return MV_say_('MVCC sheet is ready in "' + ss.getName() + '". ' + tzNote + ' Database columns found: ' + Object.keys(m.cols).map(function (k) { return MVCC.DB_COLS[k] + '=' + m.cols[k]; }).join(', ') + '.');
}
/** Puts the row-1 formulas of MVCC data (B, L:Z) back if missing or changed; converts the old per-row formulas once. */
function repairMvccFormulas() {
  requireSetupAccess_();
  var ss = MV_ss_(), r = MV_ensureFormulas_(ss), sh = ss.getSheetByName(MVCC.DATA);
  var desc = 'MVCC formula columns B and L:Z (one formula in row 1) - do not type here';
  try {
    var has = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) { return p.getDescription() === desc; });
    if (!has) { sh.getRange('B:B').protect().setDescription(desc).setWarningOnly(true); sh.getRange('L:Z').protect().setDescription(desc).setWarningOnly(true); r.push('typing warning added on B and L:Z'); }
  } catch (ignore) {}
  return MV_say_(r.length ? 'Repaired: ' + r.join('; ') + '.' : 'Formulas OK (B, L:Z row 1).');
}
/** Read-only: setup, Database, row-1 formulas against the expected ones, row counts. */
function mvccCheckSetup() {
  requireSetupAccess_();
  var ss = MV_ss_(), lines = [];
  lines.push('Time zone: ' + ss.getSpreadsheetTimeZone() + (ss.getSpreadsheetTimeZone() === MVCC.TZ ? ' (OK).' : ' (must be ' + MVCC.TZ + ').'));
  var m = MV_dbColumns_(ss);
  lines.push(m.ok ? 'Database OK (' + MV_dbStatus_(ss, false).rows + ' rows).' : m.message);
  if (m.ok) {
    var sh = ss.getSheetByName(MVCC.DATA), want = MV_arrayFormulas_(m.cols), diff = [];
    var heads = sh.getRange(1, 1, 1, MVCC.DATA_TOTAL_COLS).getFormulas()[0];
    Object.keys(want).forEach(function (c) { if (heads[MV_colNum_(c) - 1] !== want[c]) diff.push(c + '1'); });
    lines.push(diff.length ? 'Row-1 formulas missing or different in: ' + diff.join(', ') + ' (run repairMvccFormulas; every load also repairs them).' : 'Row-1 formulas OK.');
  }
  [[MVCC.DATA, 1], [MVCC.AHT, 5], [MVCC.SHORT, 1], [MVCC.PAID, 1]].forEach(function (t) { lines.push(t[0] + ': ' + Math.max(0, MV_lastRow_(ss.getSheetByName(t[0]), t[1]) - 1) + ' rows.'); });
  lines.push('Duplicate setting: ' + MV_dedupeSetting_(ss) + '.');
  return MV_say_(lines.join(' '));
}
/** Logs in to Sisense, fetches ONE day (default yesterday) and logs row counts. Writes nothing. */
function TEST_mvccSisenseProbe(day) {
  requireSetupAccess_();
  var ymd = day ? MV_ymd_(day) : MV_addDays_(MV_today_(), -1);
  CacheService.getScriptCache().remove(MVCC.SIS_TOKEN_KEY);
  var d = MV_fetchDay_(ymd);
  var msg = 'Sisense OK for ' + ymd + ': MVCC widget ' + d.A.length + ' rows, AHT interpreters ' + d.B.length + ', AHT operators ' + d.O.length + ', Short calls ' + d.C.length + '.';
  Logger.log(msg);
  Logger.log('First MVCC row: ' + JSON.stringify(d.A[0] || null));
  Logger.log('First AHT row: ' + JSON.stringify(d.B[0] || null));
  return msg;
}

/* ============================== ACCESS / HELPERS ============================== */
function MV_requireRun_() {
  requireRegistered_();
  var role = typeof dashRole_ === 'function' ? dashRole_() : '';
  var ok = MVCC.RUN_ROLES.some(function (r) { return r.toLowerCase() === String(role || '').toLowerCase(); });
  if (!ok) throw new Error('This automation is available to ' + MVCC.RUN_ROLES.join(', ') + ' only.');
  return MV_email_();
}
/** True when this role may run the automation (the dashboard shows the Start automation button). */
function MV_canRun_(role) { return MVCC.RUN_ROLES.some(function (r) { return r.toLowerCase() === String(role || '').toLowerCase(); }); }
/** Range loads: the run roles (RTM, Manager, Admin) in the app, or the app owner running it from the editor (same check as the setup functions). */
function MV_requireRangeAccess_() {
  try { return MV_requireRun_(); }
  catch (e) { try { requireSetupAccess_(); return MV_email_(); } catch (e2) { throw e; } }
}
function MV_email_() { try { return currentUserEmail_() || 'unknown'; } catch (e) { return 'unknown'; } }
function MV_takePlan_(runId) {
  var c = CacheService.getScriptCache(), raw = c.get('MVCC_RUN_' + String(runId || ''));
  if (!raw) throw new Error('This run expired or is unknown (runs are valid for 30 minutes). Start it again.');
  var plan = JSON.parse(raw);
  c.remove('MVCC_RUN_' + runId);
  return plan;
}
function MV_say_(msg) { Logger.log(msg); return msg; }
function MV_ss_() {
  var id = PropertiesService.getScriptProperties().getProperty(MVCC.PROP_ID);
  if (!id) throw new Error('The MVCC spreadsheet is not set up yet (Script Property ' + MVCC.PROP_ID + ' is missing). Ask the app owner.');
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw new Error('You do not have access to the MVCC Data spreadsheet. Ask the owner to share it with you (Editor to run the automation).'); }
}
function MV_today_() { return Utilities.formatDate(new Date(), MVCC.TZ, 'yyyy-MM-dd'); }
function MV_dateOf_(ymd) { return Utilities.parseDate(ymd, MVCC.TZ, 'yyyy-MM-dd'); }
function MV_ymdOf_(d) {
  if (Object.prototype.toString.call(d) === '[object Date]' && !isNaN(d.getTime())) return Utilities.formatDate(d, MVCC.TZ, 'yyyy-MM-dd');
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return '';
}
function MV_ymd_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return MV_ymdOf_(s);
  s = String(s || '').trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) + '-' + MV_pad_(m[1]) + '-' + MV_pad_(m[2]);
  return '';
}
function MV_pad_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function MV_addDays_(ymd, n) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
function MV_days_n_(a, b) { var p = a.split('-').map(Number), q = b.split('-').map(Number); return Math.round((Date.UTC(q[0], q[1] - 1, q[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 864e5) + 1; }
function MV_dayList_(a, b) { var out = [], d = a; while (d <= b) { out.push(d); d = MV_addDays_(d, 1); } return out; }
function MV_niceDate_(ymd) { var p = ymd.split('-').map(Number); return p[1] + '/' + p[2] + '/' + String(p[0]).slice(2); }
function MV_label_(a, b) {
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], p = a.split('-').map(Number), q = b.split('-').map(Number);
  return a === b ? p[2] + ' ' + M[p[1] - 1] + ' ' + p[0] : p[2] + ' ' + M[p[1] - 1] + ' – ' + q[2] + ' ' + M[q[1] - 1] + ' ' + q[0];
}
function MV_norm_(h) { return String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9%\/+\-]/g, ''); }
function MV_col_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function MV_colNum_(s) { return String(s).split('').reduce(function (n, ch) { return n * 26 + ch.charCodeAt(0) - 64; }, 0); }