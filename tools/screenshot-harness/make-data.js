// Synthetic demo data for rendering the WFM App UI. Every name is invented; every email is @example.com.
// Dashboard payloads are produced by the app's OWN aggregation functions (loaded from the backend source)
// from synthetic raw sheet rows, so the shapes are exactly what the real server returns.
const fs = require('fs');
const { loadBackend, parseDate } = require('./gas-sandbox');
const SRC = process.argv[2] || '../../src/backend';
const B = loadBackend(SRC);
const TZ = 'America/New_York';
const TODAY = '2026-10-20';

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const int = (a, b) => Math.floor(between(a, b + 1));

const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Rowan', 'Skyler',
  'Dana', 'Elliot', 'Harper', 'Kai', 'Logan', 'Noor', 'Omar', 'Lina', 'Yara', 'Hana', 'Rami', 'Sami'];
const LAST = ['Rivera', 'Patel', 'Nguyen', 'Kim', 'Haddad', 'Mendes', 'Okafor', 'Novak', 'Silva', 'Costa', 'Ward', 'Ali'];
const AGENTS = FIRST.map((f, i) => ({ name: f + ' ' + LAST[i % LAST.length], id: String(70100 + i * 7), nice: String(5100 + i) }));
const LANGS = ['Arabic', 'Spanish', 'French', 'Portuguese', 'Turkish'];
const TLS = ['Team Lead A', 'Team Lead B', 'Team Lead C', 'Team Lead D'];
const ACMS = ['Account Manager 1', 'Account Manager 2'];
AGENTS.forEach((a, i) => { a.lang = LANGS[i % LANGS.length]; a.tl = TLS[i % TLS.length]; a.acm = ACMS[i % 2]; a.lg = i % 6 === 5 ? 'PENs' : 'VRI'; a.skill = 0.85 + rnd() * 0.3; });

const days = [];
for (let d = 1; d <= 19; d++) days.push('2026-10-' + String(d).padStart(2, '0'));
const at = (day, h, m) => parseDate(day + ' ' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'), TZ);

// ---------- Voyce Performance (Voyce Online Hours rows A:K + roster) ----------
const voyceRows = [];
const OFF = ['Break: Lunch', 'Break: Short', 'Other:', 'Other: Missing Calls', 'Coaching: 1:1', 'System: Login issue', 'Training: Product'];
days.forEach(day => AGENTS.forEach(a => {
  if (rnd() < 0.12) return;                                  // day off
  const start = int(7, 12);
  for (let blk = 0; blk < 6; blk++) {
    const mins = int(40, 75), talk = Math.round(mins * between(0.36, 0.52) * a.skill);
    const off = rnd() < 0.16 ? (rnd() < 0.06 ? pick(['Other:', 'Other: Missing Calls']) : pick(['Break: Lunch', 'Break: Short', 'Coaching: 1:1', 'System: Login issue', 'Training: Product'])) : '';
    voyceRows.push([a.id, a.name, at(day, start + blk, int(0, 50)), off, mins, int(0, 59), off ? 0 : talk, int(0, 59), '', '', '']);
  }
  const calls = int(8, 22);
  for (let c = 0; c < calls; c++) {
    const accepted = rnd() < 0.985;
    voyceRows.push([a.id, a.name, at(day, start + int(0, 6), int(0, 59)), '', '', '', '', '', accepted ? 'ACC' : '', 'TX' + int(100000, 999999), rnd() < 0.03 ? 1 : 0]);
  }
}));
const rosterHead = ['Interpreter Name', '', '', '', 'Language Group', '', 'Status', 'FG ID', 'Voyce ID', 'Classification', 'Team Leader', 'ACM', 'Seat Language'];
const roster = [rosterHead].concat(AGENTS.map(a => [a.name, '', '', '', a.lg, '', 'Active', a.nice, a.id, 'Full time', a.tl, a.acm, a.lang]));
const normRoster = (function () { // same column mapping as VOHD_normRoster_ (header names match)
  return roster.slice(1).map(r => r.slice(0, 13));
})();
const voycePayload = B.VOHD_aggregate_(voyceRows, normRoster, TODAY, []);
voycePayload.lastLoad = at(TODAY, 9, 5).getTime();

// ---------- Adherence (Raw Data rows A:W) ----------
const adhRows = [];
const ACTS = ['Open', 'Break', 'Lunch', 'Coaching', 'Training'];
days.forEach(day => AGENTS.forEach(a => {
  if (rnd() < 0.12) return;
  ACTS.forEach(act => {
    const sm = act === 'Open' ? int(360, 420) : act === 'Lunch' ? 30 : act === 'Break' ? 30 : int(0, 1) * 30;
    if (!sm) return;
    const adh = Math.min(1, between(0.88, 1.0) * (act === 'Open' ? a.skill * 0.97 + 0.03 : 1));
    const inn = Math.round(sm * adh), out = sm - inn;
    const am = Math.round(sm * between(0.95, 1.04));
    adhRows.push([at(day, 0, 0), 'E1', 'Entity', a.nice, a.name.toUpperCase(), act, sm / 1440, am / 1440, inn, out, adh,
      am - sm, am / sm, 1, 1, a.name, a.lang, a.lg, a.tl, a.lg === 'PENs' ? 'Operator' : 'VRI', sm, 'Platform', a.acm]);
  });
}));
const adhPayload = B.ADHD_aggregate_(adhRows);
Object.assign(adhPayload, { lastLoad: at(TODAY, 8, 40).getTime(), lastBy: 'demo.rtm@example.com', lastStatus: 'OK',
  db: { ok: true, message: '', agents: AGENTS.length }, log: [], stamp: 'demo', target: B.ADHD.TARGET,
  today: TODAY, canRun: true, plan: B.ADH_plan_(TODAY) });

// ---------- MVCC Performance (MVCC data rows A:Z) ----------
const mvRows = [];
days.forEach(day => AGENTS.forEach(a => {
  if (rnd() < 0.12) return;
  const as = int(25, 60), ac = Math.round(as * between(0.95, 1.0)), to = as - ac, ca = int(0, 2);
  const ph = between(7.2, 8.0), tt = ph * between(0.32, 0.55) * a.skill;
  mvRows.push([at(day, 0, 0), 'W' + Math.ceil(+day.slice(8) / 7), 'Vendor A', a.name, as, ac, ac / as, to, ca, to / as, ca / as,
    rnd() < 0.2 ? 1 : 0, ph, tt, rnd() < 0.15 ? 1 : 0, tt / Math.max(1, ac), a.nice, a.id, a.name, a.tl, a.lang, a.lang,
    a.lg === 'PENs' ? 'operator' : 'VRI', a.lg, a.acm, a.name.toLowerCase().replace(' ', '.') + '@example.com']);
}));
const mvPayload = B.MVD_aggregate_(mvRows);
Object.assign(mvPayload, { lastLoad: at(TODAY, 8, 50).getTime(), lastPeriod: '17 Oct – 19 Oct 2026', lastStatus: 'OK', lastBy: 'demo.rtm@example.com',
  lastPaid: at(TODAY, 8, 55).getTime(), paidPeriod: '1 Oct – 19 Oct 2026', paidBy: 'demo.rtm@example.com', dedupe: 'KEEP',
  db: { ok: true, message: '', agents: AGENTS.length }, paidDays: days.map(d => [d, AGENTS.length - 3, 150.5]),
  flags: { total: 0, items: [] }, log: [], stamp: 'demo', today: TODAY, targets: B.MVD.TARGETS, canRun: true,
  backfill: B.MV_backfillPlan_(TODAY), paidPlan: B.MV_paidPlan_(TODAY) });

// ---------- App start-up, RTM Handover, Tickets ----------
const USERS = [
  { email: 'demo.manager@example.com', role: 'Manager' }, { email: 'demo.admin@example.com', role: 'Admin' },
  { email: 'alex.rivera@example.com', role: 'RTM' }, { email: 'sam.patel@example.com', role: 'RTM' },
  { email: 'jordan.nguyen@example.com', role: 'RTM' }, { email: 'taylor.kim@example.com', role: 'RTM' },
  { email: 'ops.viewer@example.com', role: 'Operations' }];
const initial = {
  authorized: true, user: { email: 'demo.manager@example.com', role: 'Manager' }, authorizedUsers: USERS,
  shifts: B.CONFIG.SHIFTS, todoStatuses: B.CONFIG.TODO_STATUSES, ticketTypes: B.CONFIG.TICKET_TYPES, ticketStatuses: B.CONFIG.TICKET_STATUSES,
  today: TODAY, timezone: TZ, webAppUrl: '', initialTodoSyncTime: 1, initialTicketSyncTime: 1, executesAsUser: true,
  features: { dayBundle: true, multiAssign: true, mentions: true, personalTodo: true }, permissions: { complete: true, missing: [], url: '' }
};
const TASKS = {
  Morning: ['Verify overnight schedule changes', 'Publish morning staffing plan', 'Check interval SLA at 09:00', 'Send intraday update #1', 'Review absence requests', 'Update adherence exceptions'],
  Mid: ['Intraday re-forecast', 'Send intraday update #2', 'Approve break swaps', 'Check queue backlog', 'Update OT coverage sheet'],
  Overnight: ['Overnight staffing check', 'Export end-of-day report', 'Prepare next-day schedule notes', 'Log system incidents']
};
const rtm = ['alex.rivera@example.com', 'sam.patel@example.com', 'jordan.nguyen@example.com'];
const shifts = {};
Object.keys(TASKS).forEach((s, si) => {
  shifts[s] = { closure: null, tasks: TASKS[s].map((t, i) => {
    const done = si === 0 ? i < 4 : si === 1 ? i < 1 : false;
    return { rowIndex: done ? 100 + i : null, date: TODAY, taskName: t, shift: s, assignedTo: done || i < 2 ? rtm[i % 3] : '',
      assignees: done || i < 2 ? [rtm[i % 3]] : [], receivedBy: done ? rtm[(i + 1) % 3] : '', status: done ? 'Completed' : (si === 0 && i === 5 ? 'Cancelled' : 'Pending'),
      comment: done && i === 1 ? 'Plan published to the team channel. @sam.patel@example.com please confirm the 14:00 cover.' : (done && i === 2 ? 'SLA 91% at 09:00, recovered by 09:30.' : ''),
      attachments: done && i === 0 ? [{ id: 'demoFileId000000000000001', name: 'schedule-changes.xlsx', url: '#', previewUrl: 'https://drive.google.com/file/d/demo/view', size: '18.2 KB', mimeType: 'application/vnd.ms-excel' }] : [] };
  }) };
});
const dayBundle = { date: TODAY, epoch: '1', cached: false, shifts };

const tk = (no, type, to, by, desc, status, pri, due, pub, cc, hoursAgo, cmts) => {
  const created = new Date(Date.parse('2026-10-20T13:00:00Z') - hoursAgo * 3600e3).toISOString();
  return { key: created, createdAt: created, no, label: 'T-' + String(no).padStart(4, '0'), ticketType: type, assignedTo: to, assignedBy: by,
    description: desc, cc, status, updatedAt: created, updatedBy: by, isPublic: pub, attachments: [], priority: pri, dueDate: due,
    commentCount: cmts, perms: { comment: true, status: true, edit: true, assign: true } };
};
const tickets = [
  tk(128, 'Issue', 'alex.rivera@example.com', 'demo.manager@example.com', 'Queue routing sends Spanish calls to the Portuguese skill group after 18:00. Please check the routing profile and confirm.', 'In Progress', 'Urgent', '2026-10-21', true, 'sam.patel@example.com', 3, 4),
  tk(127, 'Task', 'sam.patel@example.com', 'demo.manager@example.com', 'Build the November shift pattern draft for the Arabic team (target 96% adherence).', 'Open', 'High', '2026-10-24', false, '', 6, 1),
  tk(126, 'Flags', 'All Users', 'jordan.nguyen@example.com', 'Reminder: new break policy starts Monday. Breaks must be taken within the scheduled window.', 'Open', 'Normal', '', true, '', 20, 0),
  tk(125, 'Task', 'jordan.nguyen@example.com', 'demo.admin@example.com', 'Add the two new team leads to the dashboard roster.', 'Completed', 'Normal', '2026-10-19', false, '', 30, 2),
  tk(124, 'Issue', 'taylor.kim@example.com', 'alex.rivera@example.com', 'Adherence report shows a missing day for one interpreter. Re-run the load for 15 Oct.', 'Completed', 'High', '', false, 'demo.manager@example.com', 52, 3),
  tk(123, 'Task', 'alex.rivera@example.com', 'demo.manager@example.com', 'Weekly OT coverage review with the account managers.', 'Open', 'Low', '2026-10-27', false, '', 70, 0),
  tk(122, 'Issue', 'sam.patel@example.com', 'taylor.kim@example.com', 'Interval report export has an extra blank column.', 'Cancelled', 'Low', '', false, '', 96, 1)
];
const activity = { key: tickets[0].key, entries: [
  { at: tickets[0].key, actor: 'demo.manager@example.com', action: 'created', details: 'Created this ticket', meta: {} },
  { at: new Date(Date.parse(tickets[0].key) + 1800e3).toISOString(), actor: 'alex.rivera@example.com', action: 'status', details: 'Open → In Progress', meta: {} },
  { at: new Date(Date.parse(tickets[0].key) + 3600e3).toISOString(), actor: 'alex.rivera@example.com', action: 'comment', details: 'Found it: the after-hours profile still has the old skill mapping. Fix scheduled with the telephony team.', meta: {} }
] };

const myTodos = [
  { id: 'pt1', title: 'Prepare weekly adherence summary', notes: '', priority: 'high', category: 'Work', dueDate: '2026-10-21', completed: false, createdAt: '2026-10-19T10:00:00Z' },
  { id: 'pt2', title: 'Review OT requests', notes: '', priority: 'medium', category: 'Follow-up', dueDate: '2026-10-20', completed: false, createdAt: '2026-10-19T11:00:00Z' },
  { id: 'pt3', title: 'Gym after shift', notes: '', priority: 'low', category: 'Fitness', dueDate: '', completed: true, createdAt: '2026-10-18T11:00:00Z' }
];

const STAMP = String(at(TODAY, 9, 5).getTime());
const dash = (p) => ({ ok: true, stamp: STAMP, cached: false, payload: p });
const out = {
  getInitialAppData: initial, checkSystemSync: { todoChanged: false, ticketsChanged: false, serverTodoTime: 1, serverTicketTime: 1 },
  getDayBundle: dayBundle, getTickets: tickets, getTicketActivity: activity,
  getDashboardMenu: { ok: true, role: 'Manager', items: Object.keys(B.DASHBOARDS).map(id => ({ id, title: B.DASHBOARDS[id].title, subtitle: B.DASHBOARDS[id].subtitle, icon: B.DASHBOARDS[id].icon })) },
  getVoyceDashboardData: dash(voycePayload), getVoyceDashboardStamp: { ok: true, stamp: STAMP },
  getAdherenceDashboardData: dash(adhPayload), getAdherenceDashboardStamp: { ok: true, stamp: 'demo' },
  getMvccDashboardData: dash(mvPayload), getMvccDashboardStamp: { ok: true, stamp: 'demo' },
  getAssistantStatus: { configured: true, providerCount: 2, isAdmin: false, rateLimitPerHour: 40 },
  getReportingCatalog: { reports: B.REPORTING_REGISTRY }, getMyTodos: myTodos
};
fs.writeFileSync(__dirname + '/mock-data.json', JSON.stringify(out));
console.log('voyce rows', voyceRows.length, 'agents', voycePayload.agents.length, '| adh facts', adhPayload.f.d.length, '| mvcc facts', mvPayload.f.d.length);
