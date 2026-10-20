# Adding a NICE report to the WFM App (connector v1.1)

The WFM NICE Connector doesn't need to change for a new report. Each report keeps its own job definition in the app, in its own `.gs` file, as `Adherence.gs` does with `ADH_niceJob_`. The connector runs any job made of the three generic workflows below.

## Every WebStation report works the same way
This was checked live on 2026-10-08 for all 9 report types:
- **Form:** `/supv/reportAction.mvc?selectedTabAction=/<Name>ReportMain.mvc&selectedTabOverride=/generateReportWizard.mvc`. It opens a form called `<Name>ReportForm`.
- **Generate:** the form's own `submitForm('generate')`. The report then appears in View Reports.
- **Saved NICE templates:** they open the same form already filled in, at `/supv/reportAction.mvc?schRptOid=<32-hex id>`.

| Report | Form name | Formats |
|---|---|---|
| Adherence | AdherenceReportForm | PDF, DOCX, XLS, CSV |
| Conformance | ConformanceReportForm | PDF, DOCX, XLS, CSV |
| Conformance By Interval | ConformanceByIntervalReportForm | PDF, DOCX, XLS, CSV |
| Scheduled Hours | ScheduledHoursReportForm | PDF, DOCX, XLS, CSV |
| Time Utilization | TimeUtilizationReportForm | PDF, DOCX, XLS, CSV |
| WebStation Schedule Changes | ScheduleChangesReportForm | PDF, DOCX, XLS, CSV |
| Agent Schedules | AgentSchedulesReportForm | PDF, DOCX, XLS |
| Agent Schedule Calendar | AgentScheduleCalendarReportForm | PDF, XLS |
| Schedule Audit Trail | ScheduleAuditReportForm | PDF, DOCX, XLS |

Saved templates on 2026-10-08:
- ACW - UTL: `YOUR_TEMPLATE_OID_ACW_UTL`
- ADH: `YOUR_TEMPLATE_OID_ADH`
- Schedule Voyce: `YOUR_TEMPLATE_OID_SCHEDULE`
- Staffing - MVCC: `YOUR_TEMPLATE_OID_STAFFING`

## The three workflows
1. **`nice-report`**: fills a report form or opens a saved template, presses Generate, waits for the new report in View Reports, then downloads it.
   - CSV comes back as `csv` text.
   - XLS, XLSX, PDF and DOCX come back as `base64`.
   - The result also has `report: { oid, name, subject, start, end, format, check }`.
2. **`nice-fetch`**: a read-only GET of a WebStation page or JSON service (`path` under `/supv/`, `/wfm/` or `/wfmws/`). Set `json: true` to get parsed JSON back.
3. **`nice-extract`**: a read-only GET of a WebStation page. Returns one table (`table` CSS selector) as `{ header, rows }`.

To run several jobs in one go, send `{ jobs: [ ... ] }` (up to 10). They run one after the other in the same signed-in tab, and the result is `{ results: [...] }`.

## Job fields for `nice-report`
```js
{
  workflow: 'nice-report', report: 'Staffing - MVCC',          // the label used in progress messages
  templateOid: 'YOUR_TEMPLATE_OID_STAFFING',             // OR formUrl: '/supv/reportAction.mvc?selectedTabAction=/ScheduledHoursReportMain.mvc&selectedTabOverride=/generateReportWizard.mvc'
  formName: 'ConformanceByIntervalReportForm',                 // optional: by default the first form whose name ends in ReportForm
  steps: [                                                     // short form ['name', value, waitMs] or objects:
    { op: 'set', name: 'isAbsolute', value: 'true', wait: 300 },
    { op: 'set', name: 'stAbsDate', value: '10/8/26' }, ['endAbsDate', '10/8/26'],
    { op: 'move', from: 'sortOptions', to: 'selectedSortOptions', values: ['ASC_AGENT_NAME'] },   // NICE "move right" lists
    { op: 'waitOptions', name: 'intervalParam', values: ['30'] },                                   // lists NICE fills a moment later
    { op: 'waitFor', selector: '#something' }, { op: 'click', selector: '#something' },
    { op: 'call', fn: 'someNiceFunction', args: [] }                                                // the form page's own functions, by name only
  ],
  verify: ['reportFormatTypeOid', 'stAbsDate'],                // read back after filling; shown in report.check
  match: { name: 'Conformance By Interval', subject: '6 FG', start: '10/8/26', end: '10/8/26' },    // how to recognise the NEW report
  format: 'CSV',                                               // optional safety check
  expectHeader: 'Date,Entity ID,Entity Name,Agent ID',         // optional: the first line of a CSV must start with this
  timeoutSec: 420
}
```
`set` handles text fields, selects (by value or by visible text), radios, checkboxes and multi-selects (`'*'` = every option).

## Calling it from an app page
The page posts `{ __wfmNice: 1, dir: 'page', type: 'run', id, job }` (or `jobs`) to its own window. It gets back `progress`, then either `result` or `error`, as `{ __wfmNice: 1, dir: 'ext', id, ... }`. To check that the connector is there, send `type: 'hello'`; the `ready` reply carries `version` and `caps`. `Dash_Adherence_HTML` has a complete page-side helper (the `NICE` object) to copy.

## Errors
Every error has a `code`, so the page can explain what to do:

| Code | Meaning |
|---|---|
| `LOGIN` | NICE wants a sign-in. The tab came forward and the person didn't finish. |
| `APPROVAL` | The person didn't allow this app. |
| `BAD_JOB` | The job failed validation (unknown workflow, unsafe path, bad field name). |
| `BUSY` | Another run is going in this browser. |
| `FORM_CHANGED` | A field or option is missing on the NICE form. The message lists the fields that were found. |
| `NICE_REFUSED` | NICE's own validation message. |
| `NICE_PAGE` | WebStation didn't load or couldn't be scripted. |
| `TIMEOUT` | The report didn't appear in time. The message says what NICE did create. |
| `DOWNLOAD` | The download failed, or the file wasn't the expected one. |
| `TAB_CLOSED` | The NICE tab was closed during the run. |
| `CANCELLED` | The person pressed Stop. |

## Proof (2026-10-09)
- **Adherence:** the existing job (legacy short-form fields) is unchanged.
- **Mock test:** e2e passes 34/34, including a template run, object steps, XLS, extract, a JSON fetch, a batch, and the BUSY, TIMEOUT, FORM_CHANGED and BAD_JOB errors.
- **Real NICE:** the "Staffing - MVCC" template ran with new dates using these page functions. NICE accepted it, and the new Conformance By Interval report (CSV, 808 KB, 14,594 lines) was found and downloaded.
