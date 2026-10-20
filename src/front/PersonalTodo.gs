/**
 * PersonalTodo.gs — FRONT project copy of the personal "My To-Do" backend.
 *
 * PRIVACY MODEL
 * Tasks are stored in PropertiesService.getUserProperties() of THIS (front) project. The front always
 * executes as the visiting person, so the store is private to each Google account: other users, the
 * backend, and even the app owner cannot read it.
 *
 * LIMITS (Apps Script): 9 KB per property value, 500 KB per store. One property per task keeps
 * each value tiny; the cap of 300 tasks per person stays far below the store limit.
 */

const PT_PREFIX = 'PT_';
const PT_MAX_ITEMS = 300;
const PT_PRIORITIES = ['low', 'medium', 'high'];
const PT_CATEGORIES = ['Personal', 'Work', 'Shopping', 'Fitness', 'Follow-up'];

function ptGuard_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim();
  if (!email) throw new Error('Google did not identify your account. Reload the app.');
  return { email: email };
}

function assertDateStr_(dateStr) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Invalid date.');
  const y = Number(s.substr(0, 4)), m = Number(s.substr(5, 2)), d = Number(s.substr(8, 2));
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new Error('Invalid date.');
  }
  return s;
}

function ptClean_(input, existing) {
  const src = input || {};
  const title = String(src.title === undefined ? (existing ? existing.title : '') : src.title).trim();
  if (!title) throw new Error('A task needs a title.');
  if (title.length > 200) throw new Error('Title is too long (max 200 characters).');

  const notes = String(src.notes === undefined ? (existing ? existing.notes : '') : src.notes).trim();
  if (notes.length > 1000) throw new Error('Notes are too long (max 1000 characters).');

  const priority = String(src.priority || (existing ? existing.priority : 'medium'));
  if (PT_PRIORITIES.indexOf(priority) === -1) throw new Error('Invalid priority.');

  const category = String(src.category || (existing ? existing.category : 'Personal'));
  if (PT_CATEGORIES.indexOf(category) === -1) throw new Error('Invalid category.');

  let dueDate = src.dueDate === undefined ? (existing ? existing.dueDate : '') : String(src.dueDate || '').trim();
  if (dueDate) dueDate = assertDateStr_(dueDate);

  const completed = src.completed === undefined ? !!(existing && existing.completed) : (src.completed === true);

  return {
    id: existing ? existing.id : String(src.id),
    title: title,
    notes: notes,
    priority: priority,
    category: category,
    dueDate: dueDate,
    completed: completed,
    createdAt: existing ? existing.createdAt : new Date().toISOString()
  };
}

function ptReadAll_(store) {
  const all = store.getProperties();
  const items = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(PT_PREFIX) !== 0) return;
    try { items.push(JSON.parse(all[key])); } catch (e) {}
  });
  items.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0); });
  return items;
}

/** All of the signed-in user's personal tasks, newest first. */
function getMyTodos() {
  ptGuard_();
  return ptReadAll_(PropertiesService.getUserProperties());
}

/** Create or update one task. Send { id?, title, notes, priority, category, dueDate, completed }. */
function saveMyTodo(task) {
  ptGuard_();
  const store = PropertiesService.getUserProperties();
  let id = task && task.id ? String(task.id) : '';
  if (id && !/^[A-Za-z0-9\-]{8,40}$/.test(id)) throw new Error('Invalid task id.');

  let existing = null;
  if (id) {
    const raw = store.getProperty(PT_PREFIX + id);
    if (raw) { try { existing = JSON.parse(raw); } catch (e) {} }
  }
  if (!existing) {
    if (ptReadAll_(store).length >= PT_MAX_ITEMS) {
      throw new Error('You reached the limit of ' + PT_MAX_ITEMS + ' tasks. Clear completed tasks first.');
    }
    id = id || Utilities.getUuid();
  }

  const clean = ptClean_(Object.assign({}, task, { id: id }), existing);
  store.setProperty(PT_PREFIX + clean.id, JSON.stringify(clean));
  return clean;
}

function deleteMyTodo(id) {
  ptGuard_();
  const safeId = String(id || '');
  if (!/^[A-Za-z0-9\-]{8,40}$/.test(safeId)) throw new Error('Invalid task id.');
  PropertiesService.getUserProperties().deleteProperty(PT_PREFIX + safeId);
  return { success: true };
}

/**
 * Deletes completed tasks. With a list of ids (what the screen removed), only those, and only if
 * they are still completed; without one, every completed task (the original behaviour).
 */
function clearMyCompletedTodos(ids) {
  ptGuard_();
  const store = PropertiesService.getUserProperties();
  const only = Array.isArray(ids) ? ids.map(String) : null;
  let removed = 0;
  ptReadAll_(store).forEach(function (t) {
    if (!t.completed) return;
    if (only && only.indexOf(String(t.id)) === -1) return;
    store.deleteProperty(PT_PREFIX + t.id); removed++;
  });
  return { success: true, removed: removed };
}

/**
 * Undo for delete and "Clear completed": puts tasks back in one call (not one call per task, which
 * could exceed Google's limit on simultaneous runs), keeping their id and creation time. A task
 * that already exists is left as it is.
 */
function restoreMyTodos(tasks) {
  ptGuard_();
  if (!Array.isArray(tasks) || !tasks.length) return [];
  if (tasks.length > PT_MAX_ITEMS) throw new Error('Too many tasks.');
  const store = PropertiesService.getUserProperties();
  let count = ptReadAll_(store).length;
  const out = [];
  const batch = {};
  tasks.forEach(function (t) {
    const id = String((t && t.id) || '');
    if (!/^[A-Za-z0-9\-]{8,40}$/.test(id)) throw new Error('Invalid task id.');
    if (store.getProperty(PT_PREFIX + id) || batch[PT_PREFIX + id]) return;
    if (count >= PT_MAX_ITEMS) throw new Error('You reached the limit of ' + PT_MAX_ITEMS + ' tasks. Clear completed tasks first.');
    const clean = ptClean_(Object.assign({}, t, { id: id }), null);
    const created = String(t.createdAt || '');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(created)) clean.createdAt = created;
    batch[PT_PREFIX + id] = JSON.stringify(clean);
    out.push(clean);
    count++;
  });
  if (out.length) store.setProperties(batch, false);
  return out;
}