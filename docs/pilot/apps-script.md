# Pilot Feedback — Google Apps Script

The in-app feedback modal posts a report to the **local runner**, and the
runner forwards it to a **Google Apps Script web app**. The script writes a
row to a Google Sheet and saves any screenshot to a Google Drive folder.

```
dashboard modal ──▶ runner /control/pilot-feedback ──▶ Apps Script web app
                                                         ├─ Google Sheet (one row)
                                                         └─ Google Drive (screenshot)
```

The shared secret lives only in the runner's `.env` and in the script's
properties — it is never in browser code. Reports never contain message
content. This is a deliberately small, pilot-only intake — no database, no
dashboard, no auto-submit.

## One-time setup

1. **Create a Google Sheet.** Add a header row (row 1) so the first report
   becomes `R-0001`. The columns, in order:

   ```
   A reportId   B createdAt   C status   D note   E type   F title
   G description   H expected   I page   J threadId   K platform
   L browserMode   M aiHelpLevel   N appVersion   O commit   P userAgent
   Q clientTime   R receivedAt   S aiSummary   T aiArea   U aiSeverity
   V aiRepro   W screenshotUrl
   ```

   Note the **first six columns are the only ones the status endpoint
   reads** — so screenshots and descriptions can never leak into the
   "Recent reports" view.
2. **Create a Drive folder** for screenshots. Keep it private to you.
3. **New Apps Script project** (script.google.com → New project). Paste the
   [script below](#the-script).
4. **Project Settings → Script properties** — add three:
   - `SECRET` — any long random string. It must match
     `PILOT_FEEDBACK_SECRET` in the app's `.env`.
   - `SHEET_ID` — from the Sheet URL (`/spreadsheets/d/<SHEET_ID>/edit`).
   - `DRIVE_FOLDER_ID` — from the folder URL (`/folders/<DRIVE_FOLDER_ID>`).
5. **Deploy → New deployment → Web app.** Execute as **Me**; Who has access
   **Anyone with the link** (the secret is what actually gates it). Copy the
   `/exec` URL.
6. **Wire the app's `.env`:**

   ```bash
   PILOT_FEEDBACK_WEBHOOK_URL=https://script.google.com/macros/s/AKfy.../exec
   PILOT_FEEDBACK_SECRET=<the same SECRET>
   PILOT_FEEDBACK_STATUS_URL=https://script.google.com/macros/s/AKfy.../exec
   ```

   The webhook and status URL are the same `/exec` URL — `doPost` handles
   submissions, `doGet` handles the status read.

Re-deploy the web app after any script change (Deploy → Manage deployments
→ edit → new version).

## The script

```javascript
/**
 * Relationship Inbox OS — pilot feedback intake.
 * doPost: append a report row (+ optional screenshot to Drive).
 * doGet:  return recent reports (safe columns only) for the in-app view.
 */

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var body = JSON.parse(e.postData.contents);
    if (!body || body.secret !== props.getProperty('SECRET')) {
      return json_({ ok: false, error: 'unauthorised' });
    }

    var report = body.report || {};
    var meta = report.meta || {};
    var ai = report.ai || {};

    var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheets()[0];
    // Header is row 1, so getLastRow() before the append gives the new id:
    // first report -> 1 -> R-0001.
    var reportId = 'R-' + ('000' + sheet.getLastRow()).slice(-4);

    var screenshotUrl = '';
    if (report.screenshot && report.screenshot.base64) {
      var bytes = Utilities.base64Decode(report.screenshot.base64);
      var blob = Utilities.newBlob(
        bytes,
        report.screenshot.mimeType || 'image/png',
        reportId + '-' + (report.screenshot.name || 'screenshot')
      );
      var folder = DriveApp.getFolderById(props.getProperty('DRIVE_FOLDER_ID'));
      screenshotUrl = folder.createFile(blob).getUrl();
    }

    sheet.appendRow([
      reportId,                       // A reportId
      new Date(),                     // B createdAt
      'new',                          // C status
      '',                             // D note (you fill this in)
      report.type || '',              // E type
      report.title || '',             // F title
      report.description || '',       // G description
      report.expected || '',          // H expected
      meta.route || '',               // I page
      meta.threadId || '',            // J threadId
      meta.platform || '',            // K platform
      meta.browserMode || '',         // L browserMode
      meta.aiHelpLevel || '',         // M aiHelpLevel
      meta.appVersion || '',          // N appVersion
      meta.commit || '',              // O commit
      meta.userAgent || '',           // P userAgent
      meta.timestamp || '',           // Q clientTime
      meta.receivedAt || '',          // R receivedAt
      ai.summary || '',               // S aiSummary
      ai.area || '',                  // T aiArea
      ai.severity || '',              // U aiSeverity
      (ai.repro || []).join(' | '),   // V aiRepro
      screenshotUrl                   // W screenshotUrl
    ]);

    return json_({ ok: true, reportId: reportId });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (!e || !e.parameter || e.parameter.secret !== props.getProperty('SECRET')) {
      return json_({ ok: false, error: 'unauthorised' });
    }
    var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheets()[0];
    var last = sheet.getLastRow();
    if (last < 2) return json_({ ok: true, reports: [] });

    // Read ONLY columns A-F. Description, screenshot URL and other columns
    // are never returned to the in-app view.
    var rows = sheet.getRange(2, 1, last - 1, 6).getValues();
    var reports = rows.map(function (r) {
      var created = r[1] instanceof Date ? r[1].toISOString().slice(0, 10) : String(r[1]);
      return {
        reportId: String(r[0]),
        createdAt: created,
        status: String(r[2] || 'new'),
        note: String(r[3] || ''),
        type: String(r[4] || ''),
        title: String(r[5] || '')
      };
    });
    reports.reverse();
    return json_({ ok: true, reports: reports.slice(0, 25) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Notes

- **Secret check.** Both handlers reject anything without the matching
  `SECRET`. Apps Script `doPost` cannot read request headers, so the runner
  sends the secret as a body field; `doGet` takes it as a `?secret=` query
  parameter. The runner adds both — the browser never sees either.
- **No message content.** The runner only ever forwards the tester's typed
  fields plus safe metadata. There is no field in the payload through which
  conversation text could arrive.
- **Screenshots** are user-attached and optional. They are stored in your
  private Drive folder; the status endpoint never returns the URL.
- **`status` and `note`** (columns C and D) are yours to edit in the Sheet.
  Whatever you type shows up in each tester's "Recent reports" view.
