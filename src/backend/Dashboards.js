/**
 * Dashboards.gs — NEW FILE. The shared part of every dashboard (today: Voyce Performance).
 * -----------------------------------------------------------------------------
 * ONE list says which dashboards exist and which roles may open each one. The sidebar asks
 * getDashboardMenu() at start-up and shows only what the person may open; every dashboard's server
 * functions call requireDashboardAccess_(id) first, so the browser is never the security boundary.
 *
 * To add a dashboard later:
 *   1. add one entry to DASHBOARDS below (id, title, roles, icon);
 *   2. add its server file (e.g. Dash_Sales.gs) whose public functions start with requireDashboardAccess_('sales');
 *   3. add its page file (e.g. Dash_Sales_HTML.html) that calls WFM_Dashboards.register({ id: 'sales', ... });
 *   4. include that page in Index.html next to Dash_Voyce_HTML.
 * Nothing else in the app changes.
 *
 * Depends on the existing requireRegistered_(), currentUserEmail_() and getRolesDirectory_().
 * No ScriptApp, no new permission.
 */

var DASHBOARDS = {
  voyce: {
    title: 'Voyce Performance',
    subtitle: 'Interpreter productivity, calls and offline codes',
    roles: ['RTM', 'Manager', 'Admin', 'Operations'],
    icon: 'activity'
  },
  adherence: {
    title: 'Adherence',
    subtitle: 'NICE schedule adherence by queue, team and interpreter',
    roles: ['RTM', 'Manager', 'Admin', 'Operations'],
    icon: 'clock'
  },
  mvcc: {
       title: 'MVCC Performance',
       subtitle: 'Productivity, CSR, abandoned and short calls',
       roles: ['RTM', 'Manager', 'Admin', 'Operations'],
       icon: 'activity'
     },
  acw: {
    title: 'ACW Performance',
    subtitle: 'After-call work per accepted call against the 10 s target',
    roles: ['RTM', 'Manager', 'Admin', 'Operations'],
    icon: 'clock'
  }

};

/** Public: dashboards the signed-in person may open (order = order of DASHBOARDS). */
function getDashboardMenu() {
  requireRegistered_();
  var role = dashRole_();
  var items = Object.keys(DASHBOARDS).filter(function (id) { return dashRoleAllowed_(DASHBOARDS[id], role); })
    .map(function (id) { var d = DASHBOARDS[id]; return { id: id, title: d.title, subtitle: d.subtitle || '', icon: d.icon || '' }; });
  return { ok: true, role: role, items: items };
}

/** Guard for every dashboard server function. Throws when the role may not open that dashboard. */
function requireDashboardAccess_(id) {
  requireRegistered_();
  var d = DASHBOARDS[id];
  if (!d) throw new Error('Unknown dashboard.');
  if (!dashRoleAllowed_(d, dashRole_())) throw new Error('The ' + d.title + ' dashboard is not available for your role.');
  return d;
}

/** Role of the signed-in person from the Roles sheet ('' when not found). */
function dashRole_() {
  var email = String(currentUserEmail_() || '').toLowerCase().trim();
  if (!email) return '';
  var dir = getRolesDirectory_(), role = String((dir && dir.byEmail && dir.byEmail[email]) || '').trim();
  var known = ['Admin', 'Manager', 'RTM', 'Operations'];                // return the standard spelling
  for (var i = 0; i < known.length; i++) if (known[i].toLowerCase() === role.toLowerCase()) return known[i];
  return role;
}

function dashRoleAllowed_(d, role) {
  var r = String(role || '').toLowerCase();
  if (!r) return false;
  for (var i = 0; i < d.roles.length; i++) if (d.roles[i].toLowerCase() === r) return true;
  return false;
}