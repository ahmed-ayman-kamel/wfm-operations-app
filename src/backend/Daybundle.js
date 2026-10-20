/**
 * DayBundle.gs
 * Fast loading of a whole day (all three shifts) in ONE server call.
 *
 * WHY THIS EXISTS (time-of-day filter slowness)
 * Every switch between Morning / Mid / Overnight used to call getTasksForShift(), which read the
 * ENTIRE Todo List (all 8 columns, including attachment JSON) and formatted every date cell with
 * Utilities.formatDate() just to show about ten rows. The cost grows with history.
 *
 * WHAT CHANGED
 * 1. One call returns all three shifts for the date, so the browser switches shifts with no server call.
 * 2. Only the date column is scanned (numeric compare, no formatDate per row); then only the matching
 *    rows are read, in one contiguous block when possible.
 * 3. The result is cached in CacheService under a key that contains the todo "mutation clock"
 *    (WFM_MUTATION_TODO). Every write, and every manual sheet edit, bumps that clock, so a stale
 *    entry can never be served after a change.
 *
 * The old getTasksForShift(dateStr, shift) keeps its exact output shape and is now a thin wrapper,
 * so older browser tabs keep working during rollout.
 */

const DAY_CACHE_PREFIX = 'WFM_DAY_';

function getTodoEpoch_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('WFM_MUTATION_TODO') || '0';
  } catch (e) {
    return '0';
  }
}

/** [start, end) in epoch ms for a yyyy-MM-dd date in the given timezone. */
function dayRangeMs_(dateStr, tz) {
  const start = Utilities.parseDate(dateStr, tz, 'yyyy-MM-dd').getTime();
  const y = Number(dateStr.substr(0, 4)), m = Number(dateStr.substr(5, 2)), d = Number(dateStr.substr(8, 2));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextStr = next.getUTCFullYear() + '-' +
    ('0' + (next.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + next.getUTCDate()).slice(-2);
  const end = Utilities.parseDate(nextStr, tz, 'yyyy-MM-dd').getTime();
  return { start: start, end: end };
}

/** Row numbers (1-based, ascending) in Todo List whose Date equals dateStr. Reads column A only. */
function readDayRowNumbers_(todoSheet, tz, dateStr) {
  const lastRow = todoSheet.getLastRow();
  if (lastRow < 2) return [];
  const range = dayRangeMs_(dateStr, tz);
  const col = todoSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const rows = [];
  for (let i = 0; i < col.length; i++) {
    const v = col[i][0];
    let hit;
    if (v instanceof Date) {
      const t = v.getTime();
      hit = (t >= range.start && t < range.end);
    } else {
      hit = (String(v || '').trim() === dateStr);
    }
    if (hit) rows.push(i + 2);
  }
  return rows;
}

/**
 * Reads numCols columns starting at startCol for the given row numbers.
 * One read when the rows sit close together, otherwise one read per contiguous run.
 * Returns [{ row, values }] in ascending row order.
 */
function readRowsByNumbers_(sheet, rowNums, startCol, numCols) {
  if (!rowNums.length) return [];
  const first = rowNums[0], last = rowNums[rowNums.length - 1];
  const out = [];
  if (last - first + 1 <= 150) {
    const block = sheet.getRange(first, startCol, last - first + 1, numCols).getValues();
    for (let i = 0; i < rowNums.length; i++) {
      out.push({ row: rowNums[i], values: block[rowNums[i] - first] });
    }
    return out;
  }
  let runStart = 0;
  for (let i = 1; i <= rowNums.length; i++) {
    if (i === rowNums.length || rowNums[i] !== rowNums[i - 1] + 1) {
      const from = rowNums[runStart], len = i - runStart;
      const block = sheet.getRange(from, startCol, len, numCols).getValues();
      for (let j = 0; j < len; j++) out.push({ row: from + j, values: block[j] });
      runStart = i;
    }
  }
  return out;
}

function closureFromRow_(row) {
  const isLocked = (row[8] === true || String(row[8]).toLowerCase() === 'true');
  return {
    isLocked: isLocked,
    closedAt: normalizeIsoOrDate_(row[2]),
    closedBy: String(row[3] || '').trim(),
    totalTasks: Number(row[4] || 0),
    completedCount: Number(row[5] || 0),
    cancelledCount: Number(row[6] || 0),
    notes: String(row[7] || '').trim()
  };
}

/** Latest closure per shift for one date (same "latest row wins" rule as getShiftClosureInfo_). */
function readClosuresForDate_(ss, tz, dateStr) {
  const result = {};
  const sheet = ss.getSheetByName(CONFIG.SHEETS.SHIFT_CLOSURES);
  if (!sheet) return result;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;
  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (normalizeSheetDate_(data[i][0], tz) !== dateStr) continue;
    const shift = String(data[i][1]).trim();
    if (result[shift] === undefined) result[shift] = closureFromRow_(data[i]);
  }
  return result;
}

/** Builds the bundle straight from the sheets (no cache). Used by writers that hold the lock. */
function buildDayBundle_(ss, tz, dateStr) {
  const todoSheet = ss.getSheetByName(CONFIG.SHEETS.TODO_LIST);
  const rowNums = readDayRowNumbers_(todoSheet, tz, dateStr);
  const blocks = readRowsByNumbers_(todoSheet, rowNums, 1, 8);

  const existing = {};
  CONFIG.SHIFTS.forEach(function (s) { existing[s] = {}; });

  for (let i = 0; i < blocks.length; i++) {
    const row = blocks[i].values;
    const shift = String(row[2]).trim();
    if (!existing[shift]) continue;

    const taskName = String(row[1]).trim();
    let attachments = [];
    try {
      attachments = row[7] ? JSON.parse(row[7]) : [];
    } catch (e) {
      attachments = [];
    }
    const assignedTo = String(row[3] || '');

    // Later rows overwrite earlier ones, exactly like the previous implementation.
    existing[shift][taskName] = {
      rowIndex: blocks[i].row,
      date: dateStr,
      taskName: taskName,
      shift: shift,
      assignedTo: assignedTo,
      assignees: normalizeEmailList_(assignedTo),
      receivedBy: String(row[4] || ''),
      status: String(row[5] || 'Pending'),
      comment: String(row[6] || ''),
      attachments: attachments
    };
  }

  const closures = readClosuresForDate_(ss, tz, dateStr);
  const master = getMasterTasks_();
  const shifts = {};

  CONFIG.SHIFTS.forEach(function (shift) {
    const tasks = [];
    master.forEach(function (m) {
      if (m.shift !== shift) return;
      if (existing[shift][m.name]) {
        tasks.push(existing[shift][m.name]);
      } else {
        tasks.push({
          rowIndex: null,
          date: dateStr,
          taskName: m.name,
          shift: shift,
          assignedTo: '',
          assignees: [],
          receivedBy: '',
          status: 'Pending',
          comment: '',
          attachments: []
        });
      }
    });
    shifts[shift] = { tasks: tasks, closure: closures[shift] || null };
  });

  return { date: dateStr, shifts: shifts };
}

/**
 * Public: all three shifts for a date in one call (cached).
 * Response: { date, epoch, cached, shifts: { Morning: {tasks, closure}, Mid: {...}, Overnight: {...} } }
 */
function getDayBundle(dateStr) {
  requireRegistered_();
  const date = assertDateStr_(dateStr);
  const epoch = getTodoEpoch_();
  const cache = CacheService.getScriptCache();
  const key = DAY_CACHE_PREFIX + epoch + '_' + date;

  const hit = cache.get(key);
  if (hit) {
    try {
      const parsed = JSON.parse(hit);
      parsed.cached = true;
      return parsed;
    } catch (e) {}
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bundle = buildDayBundle_(ss, ss.getSpreadsheetTimeZone(), date);
  bundle.epoch = epoch;
  bundle.cached = false;

  try {
    cache.put(key, JSON.stringify(bundle), CONFIG.CACHE_TTL_DAY);
  } catch (e) {
    // Larger than the 100 KB cache limit: still fine, just not cached.
  }
  return bundle;
}

/**
 * Backward compatible: same signature and output as before ({ tasks, closure }).
 * Older open browser tabs and closeShift-style callers keep working.
 */
function getTasksForShift(dateStr, shift) {
  requireRegistered_();
  const s = String(shift || '').trim();
  if (CONFIG.SHIFTS.indexOf(s) === -1) return { tasks: [], closure: null };
  const bundle = getDayBundle(dateStr);
  return bundle.shifts[s];
}

/**
 * Row lookup for writes. Scans bottom-up so the row that is DISPLAYED (last one wins when
 * duplicates exist) is the row that gets EDITED. Previously reads used the last duplicate but
 * writes used the first, so edits could appear not to stick.
 */
function findTodoRow_(todoSheet, tz, dateStr, shift, taskName) {
  const rowNums = readDayRowNumbers_(todoSheet, tz, dateStr);
  if (!rowNums.length) return -1;
  const blocks = readRowsByNumbers_(todoSheet, rowNums, 2, 2); // columns B:C
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (String(blocks[i].values[1]).trim() === shift &&
        String(blocks[i].values[0]).trim() === taskName) {
      return blocks[i].row;
    }
  }
  return -1;
}