// Loads the real WFM backend .js files into a Node VM with a minimal Apps Script stand-in,
// so the app's own PURE functions (dashboard aggregations, date helpers, plans) can run on synthetic rows.
// Nothing here talks to Google. Only functions that do not touch Sheets/Drive are called.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function tzParts(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const o = {};
  f.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  return o;
}
function formatDate(d, tz, pat) {
  const p = tzParts(d, tz || 'America/New_York');
  return String(pat)
    .replace(/yyyy/g, p.year).replace(/yy/g, p.year.slice(2))
    .replace(/MM/g, p.month).replace(/dd/g, p.day)
    .replace(/HH/g, p.hour).replace(/mm/g, p.minute).replace(/ss/g, p.second)
    .replace(/EEE/g, p.weekday);
}
// yyyy-MM-dd (optionally HH:mm[:ss]) wall clock in tz -> Date
function parseDate(s, tz, pat) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // find offset of tz at that moment
  const p = tzParts(new Date(guess), tz || 'America/New_York');
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess - (asUtc - guess));
}

function makeSandbox() {
  const store = {};
  const props = { getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); }, deleteProperty: k => { delete store[k]; } };
  const cache = { get: () => null, put: () => {}, remove: () => {}, getAll: () => ({}), putAll: () => {}, removeAll: () => {} };
  const ctx = {
    console, Date, Math, JSON, Intl,
    Logger: { log: () => {} },
    Utilities: {
      formatDate, parseDate,
      base64Encode: s => Buffer.from(s).toString('base64'),
      base64Decode: s => Buffer.from(s, 'base64'),
      getUuid: () => require('crypto').randomUUID(),
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      parseCsv: t => String(t).split(/\r?\n/).map(l => l.split(','))
    },
    PropertiesService: { getScriptProperties: () => props, getUserProperties: () => props },
    CacheService: { getScriptCache: () => cache, getUserCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'demo.manager@example.com' }), getEffectiveUser: () => ({ getEmail: () => 'demo.manager@example.com' }) }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

function loadBackend(dir) {
  const ctx = makeSandbox();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !/^(test|Temp)\.js$/.test(f));
  // one combined script so top-level const/let declarations share a scope, like Apps Script
  const src = files.map(f => '// ---- ' + f + '\n' + fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
  vm.runInContext(src + '\n;globalThis.__fns = {VOHD_aggregate_, ADHD_aggregate_, MVD_aggregate_, ADH_plan_, MV_backfillPlan_, MV_paidPlan_, ADH_canRun_, MV_canRun_, REPORTING_REGISTRY, DASHBOARDS, VOHD, ADHD, MVD, CONFIG};', ctx, { filename: 'backend-bundle.js' });
  return ctx.__fns;
}

module.exports = { loadBackend, formatDate, parseDate };
