# Architecture

This document maps the source files to their responsibilities and describes the main data flows. It was written from a full read of the API, auth, bridge and core modules and a structural review (headers, public entry points, data shapes) of the feature modules.

## Deployments

| Project | Execute as | Who has access | Role |
|---|---|---|---|
| Backend (`src/backend`) | Me (owner) | Anyone | Only code that reads/writes the spreadsheet and Drive. Entry point `doPost` in `api.js`. Its `doGet` refuses to serve the app page (it returns plain text), so the page can never run as the owner. |
| Front (`src/front`) | User accessing the web app | Anyone (signed in with Google) | Serves the page, proves identity with `ScriptApp.getIdentityToken()`, sends signed emails as the user, keeps each user's private to-do list in `UserProperties`. |

`appsscript.json` (backend) enables the advanced services Drive v3, Sheets v4 and Gmail v1 and requests the scopes: Sheets, Drive, `script.send_mail`, `userinfo.email`, `script.external_request`.

## Request lifecycle

1. The browser loads the front `/exec` URL. `Bridge.gs#doGet` checks that the user granted the front's scopes, then calls the backend with action `page`.
2. Backend `api.js#doPost`:
   - `verifyIdentityToken_`: POST to `oauth2.googleapis.com/tokeninfo`; checks `aud` against `API_ALLOWED_AUD`, the issuer, `email_verified` and expiry; caches the result until the token expires.
   - Sets `API_REQUEST_EMAIL_`, which `Auth.js#currentUserEmail_` returns, so every existing role check sees the **caller**, not the owner.
   - `whoami` / `page` are handled directly; any other action must be a key of `API_FUNCS_` and the caller's role must be allowed for it.
   - Mail produced during the request is collected in `API_OUTBOX_` and returned HMAC-signed (`apiSignMail_`).
   - Changing actions and denied attempts are appended to the `Audit Log` sheet (throttled for denials).
3. The front injects `window.WFM_API = { url, token, initialData }` into the page. `ApiShim.html` swaps `google.script.run` for a Proxy that POSTs to the backend (a "simple" `text/plain` request, so no CORS preflight), refreshes the token before expiry and retries once on an expired token.
4. If the response carries signed mail, the shim calls the front's `sendSignedMail`, which verifies the signature, recipient account, expiry and nonce before calling `MailApp`.

## Module map

| File(s) | Responsibility | Public entry points (examples) |
|---|---|---|
| `Code.js` | Config, `doGet`, schema bootstrap, roles/master-task caches, attachments, handover writes, shift close/reopen, CSV export, duplicate repair | `getInitialAppData`, `updateTaskField`, `updateTodoCommentWithFiles`, `closeShift`, `reopenShift`, `exportRawSheetToCsv` |
| `Auth.js` | Identity, role guards, input validation, permission (scope) status | `requireRegistered_`, `requireElevated_`, `requireAdmin_`, `assertDateStr_`, `assertShift_` |
| `api.js` | Backend HTTP API, token verification, role allow-list, audit log, mail signing | `doPost`, `apiSetupMailKey` |
| `Daybundle.js` | Loads one date's three shifts in one call; cache keyed by the mutation clock | `getDayBundle`, `getTasksForShift` |
| `Tickets.js` | Ticket schema/migration, permissions matrix, activity log, emails | `getTickets`, `createTicket`, `updateTicket`, `addTicketComment`, `getTicketActivity` |
| `Notify.js` | All email: `@mention` detection, ticket emails, notification log | `notifyCommentMentions_`, `sendTicketNotificationEmail_` |
| `Personaltodo.js` | Private per-user to-do list in `UserProperties`; refuses to run in owner mode | `getMyTodos`, `saveMyTodo`, `deleteMyTodo`, `restoreMyTodos` |
| `Assistant.js` | AI assistant: ordered providers, adapters (OpenAI, Anthropic, Gemini, OpenAI-compatible, Azure header), cooldowns and strikes for failing providers, retry/backoff, per-user hourly rate limit, key redaction | `askAssistant`, `getAssistantStatus`, `saveAiSettings`, `testAiProvider` |
| `Reporting.js` | Layered report pipeline: file parsing (CSV/TSV/XLSX via Drive conversion), header-based table recognition, New York time-zone-safe date handling, cleaning and de-duplication | `getReportingCatalog`, `runVoycePerformanceReport` |
| `ReportAutomation.js`, `ReportAutomationEntry.js` | Fetches vendor reports: portal session login, run → poll → CSV download; BI login + JAQL query; hands results to the same pipeline as a manual upload | `runAutomatedVoyceReports` |
| `Voyceonlinehours.js` | Loads report data into the dashboard data sheet: chunked and resumable initial load, hourly reload of yesterday + today (trigger created by hand), upsert in date order, self-repairing row-1 array formulas, "Ign" exclusion column | `loadVoyceOnlineHours`, `vohScheduledHourly` |
| `Adherence.js` | WFM adherence pipeline: plans the period, returns steps for the browser extension, validates and saves the CSV, maintains lookup formulas | `adhStartRun`, `adhSaveReport`, `adhReportRunFailure` |
| `Mvcc.js` | MVCC report: BI pulls for data/AHT/short calls (3-day re-pull window), paid hours via the extension, flags for unknown agents and duplicates | `mvccBackfillSisense`, `mvccStartPaidHours`, `mvccSavePaidHours` |
| `Dashboards.js` | Dashboard registry and role gate (one list; sidebar is built from it) | `getDashboardMenu`, `requireDashboardAccess_` |
| `Dash_Voyce.js`, `Dash_Adherence.js`, `Dash_Mvcc.js` | Read the data sheets and return compact columnar payloads; pure `*_aggregate_` functions; gzip+base64 chunked caching | `get*DashboardData`, `get*DashboardStamp` |
| `Setup.js`, `Hardening.js` | Owner/Admin editor tools: deployment setup, sharing, sharing report, link-sharing lockdown, plain-text hardening | `setupDeployment`, `reportAccess`, `closeLinkSharing`, `hardenSheets` |
| `Index.html`, `Styles.html` | App shell, navigation, theme, design tokens (light/dark) | — |
| `ToDo.html`, `Tickets_HTML.html`, `Assistant_HTML.html`, `Reporting_HTML.html`, `Dashboards_HTML.html`, `Dash_*_HTML.html` | Module front ends (vanilla JS; dashboards draw charts on canvas/SVG; XLSX export written in the browser) | — |
| `ApiShim.html` | Browser-side transport to the backend | — |
| `src/front/Bridge.gs` | Front project: page, identity token, signed mail, slow-route stubs | `doGet`, `sendSignedMail`, `getIdToken`, `checkFrontSetup`, `showMyAudience` |
| `src/front/PersonalTodo.gs` | Private to-do store in the front project's `UserProperties` | `getMyTodos`, `saveMyTodo`, `deleteMyTodo` |
| `extension/wfm-nice-connector/` | `background.js` (service worker: approvals, job runner, tab control), `nice_page.js` (runs inside WFM report pages: fill, generate, download), `content.js` (bridge in the app frame), `popup.*`, `approve.*` | — |

## Data model (main spreadsheet)

| Sheet | Columns |
|---|---|
| `Roles` | Email, Role |
| `Daily Tasks` | Task Name, Shift (the master checklist) |
| `Todo List` | Date, Task Name, Shift, Assigned To, Received By, Status, Comment, Attachments (JSON) |
| `Shift Closures` | Date, Shift, Closed At, Closed By, Total Tasks, Completed Count, Cancelled Count, Handover Notes, Is Locked |
| `Tickets` | Created At (key), Type, Assigned To, Assigned By, Description, CC, Status, Updated At, Is Public, Attachments, Ticket No, Priority, Due Date, Updated By, Comments |
| `Ticket Activity` | Timestamp, Ticket Key, Ticket No, Actor, Action, Details, Meta |
| `Notification Log` | Timestamp, Type, From, To, Date, Shift, Task, Status, Error |
| `Audit Log` | Timestamp, Email, Role, Action, Result, Details |

Dashboard data lives in separate spreadsheets (ids in Script Properties), each with `_Control` and `_Load Log` tabs and a `Database` tab imported from the team's roster.

## Not included

The code mentions `WFM_App_Documentation.md` and `tests/reporting_test.js`; they are not part of this repository yet.

Front `appsscript.json` scopes: `openid`, `userinfo.email`, `script.external_request`, `script.send_mail`.
