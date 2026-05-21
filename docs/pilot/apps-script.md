# Pilot Feedback: Google Apps Script

The in-app feedback modal posts a report to the **local runner**, and the
runner forwards it to a **Google Apps Script web app**. The script writes a
row to a Google Sheet, saves any screenshot to Google Drive, and (optionally)
opens a GitHub issue for triage.

```
dashboard modal ──▶ runner /control/pilot-feedback ──▶ Apps Script web app
                                                         ├─ Google Sheet (one row, the source of truth)
                                                         ├─ Google Drive (screenshot, if attached)
                                                         └─ GitHub issue (optional, admin side only)
```

The shared secret lives only in the runner's `.env` and in the script's
properties. It is never in browser code. Reports never contain message
content. The **Sheet is the source of truth**: GitHub issue sync is optional
and best effort, so if it is off or fails, the report is still stored and the
tester's submission still counts as sent.

Testers never see or touch GitHub. They press **Submit report** and get a
report number. Everything below is admin side, for whoever runs the pilot.

## One-time setup

1. **Create a Google Sheet.** Add a header row (row 1) so the first report
   becomes `R-0001`. The columns, in order:

   ```
   A reportId   B createdAt   C status   D note   E type   F title
   G description   H expected   I page   J threadId   K platform
   L browserMode   M aiHelpLevel   N appVersion   O commit   P userAgent
   Q clientTime   R receivedAt   S aiSummary   T aiArea   U aiSeverity
   V aiRepro   W screenshotUrl   X githubIssueUrl   Y githubIssueNumber
   Z githubSyncStatus   AA githubSyncError
   ```

   Columns X to AA are written by the script; you never fill them in. The
   header labels are cosmetic (the script uses column positions), but adding
   them keeps the Sheet readable. The **first six columns are the only ones
   the status endpoint reads**, so descriptions, screenshots, and the GitHub
   columns can never leak into the tester-facing "Recent reports" view.
2. **Create a Drive folder** for screenshots. Keep it private to you.
3. **New Apps Script project** (script.google.com, New project). Paste the
   [script below](#the-script).
4. **Project Settings, Script properties**, add three:
   - `SECRET`: any long random string. It must match
     `PILOT_FEEDBACK_SECRET` in the app's `.env`.
   - `SHEET_ID`: from the Sheet URL (`/spreadsheets/d/<SHEET_ID>/edit`).
   - `DRIVE_FOLDER_ID`: from the folder URL (`/folders/<DRIVE_FOLDER_ID>`).

   GitHub issue sync needs a few more properties. It is optional: see
   [GitHub issue sync](#optional-github-issue-sync) below. With none of them
   set, the script never calls GitHub and just records `skipped` in the Sheet.
5. **Deploy, New deployment, Web app.** Execute as **Me**; Who has access
   **Anyone with the link** (the secret is what actually gates it). Copy the
   `/exec` URL.
6. **Wire the app's `.env`:**

   ```bash
   PILOT_FEEDBACK_WEBHOOK_URL=https://script.google.com/macros/s/AKfy.../exec
   PILOT_FEEDBACK_SECRET=<the same SECRET>
   PILOT_FEEDBACK_STATUS_URL=https://script.google.com/macros/s/AKfy.../exec
   ```

   The webhook and status URL are the same `/exec` URL. `doPost` handles
   submissions, `doGet` handles the status read.

Re-deploy the web app after any script change (Deploy, Manage deployments,
edit, New version).

## The script

```javascript
/**
 * Relationship Inbox OS: pilot feedback intake.
 *
 * doPost: append a report row, save any screenshot to Drive, then (when
 *         GitHub issue sync is configured) open a GitHub issue and record
 *         the result back into the row.
 * doGet:  return recent reports (safe columns only) for the in-app view.
 *
 * The Sheet is the source of truth. GitHub issue sync is optional and best
 * effort: if it is off or fails, the report is still stored and the tester
 * submission still counts as sent. Only a failure to store the report
 * itself fails the request.
 */

// Sheet columns A..AA, 1-based. The first six are the only ones doGet
// returns, so nothing from column G onward can reach the in-app view.
var COL = {
  reportId: 1, createdAt: 2, status: 3, note: 4, type: 5, title: 6,
  description: 7, expected: 8, page: 9, threadId: 10, platform: 11,
  browserMode: 12, aiHelpLevel: 13, appVersion: 14, commit: 15,
  userAgent: 16, clientTime: 17, receivedAt: 18, aiSummary: 19,
  aiArea: 20, aiSeverity: 21, aiRepro: 22, screenshotUrl: 23,
  githubIssueUrl: 24, githubIssueNumber: 25, githubSyncStatus: 26,
  githubSyncError: 27
};
var COLUMN_COUNT = 27;

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var props = PropertiesService.getScriptProperties();
    var body = JSON.parse(e.postData.contents);
    if (!body || body.secret !== props.getProperty('SECRET')) {
      return json_({ ok: false, error: 'unauthorised' });
    }

    // Serialise appends so the report id and the appended row number cannot
    // race between two concurrent submissions.
    lock.waitLock(30000);

    var report = body.report || {};
    var meta = report.meta || {};
    var ai = report.ai || {};

    var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheets()[0];
    // Header is row 1, so getLastRow() before the append gives the new id:
    // first report -> 1 -> R-0001. The appended row is lastRow + 1.
    var lastRow = sheet.getLastRow();
    var reportId = 'R-' + ('000' + lastRow).slice(-4);

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
      // X..AA (GitHub columns) are written by syncGithubForRow_ below.
    ]);

    // The report is stored: from here the submission counts as sent. GitHub
    // sync is best effort, so it is fully wrapped and can never fail the
    // request. Its outcome goes into columns X..AA.
    var rowNumber = lastRow + 1;
    var sync;
    try {
      sync = syncGithubForRow_(props, sheet, rowNumber);
    } catch (syncErr) {
      writeGithubColumns_(sheet, rowNumber, '', '', 'failed', String(syncErr));
      sync = { status: 'failed' };
    }

    return json_({ ok: true, reportId: reportId, githubSync: sync.status });
  } catch (err) {
    // Reaching here means the report could not be stored: the only case
    // that fails the whole request.
    return json_({ ok: false, error: String(err) });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
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

    // Read ONLY columns A-F. Description, screenshot URL, the GitHub
    // columns and everything else are never returned to the in-app view.
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

/**
 * Create a GitHub issue for one Sheet row and record the result in columns
 * X..AA. Used by doPost (the row just appended) and syncMissingGitHubIssues
 * (older rows). Idempotent per row: a row that already has an issue URL is
 * left untouched, so no row ever gets a second issue.
 *
 * Returns { status: 'created' | 'skipped' | 'failed' }.
 */
function syncGithubForRow_(props, sheet, rowNumber) {
  var values = sheet.getRange(rowNumber, 1, 1, COLUMN_COUNT).getValues()[0];

  // Idempotency: never re-sync a row that already has an issue URL.
  if (String(values[COL.githubIssueUrl - 1] || '').trim()) {
    return { status: 'skipped' };
  }

  var enabled = String(props.getProperty('GITHUB_ISSUES_ENABLED') || '')
    .trim().toLowerCase() === 'true';
  if (!enabled) {
    writeGithubColumns_(sheet, rowNumber, '', '', 'skipped', 'GitHub sync disabled');
    return { status: 'skipped' };
  }

  var owner = String(props.getProperty('GITHUB_OWNER') || '').trim();
  var repo = String(props.getProperty('GITHUB_REPO') || '').trim();
  var token = String(props.getProperty('GITHUB_TOKEN') || '').trim();
  if (!owner || !repo || !token) {
    writeGithubColumns_(sheet, rowNumber, '', '', 'failed',
      'GitHub sync is enabled but GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN are not all set.');
    return { status: 'failed' };
  }

  try {
    var issue = buildIssueContent_(props, values);
    var result = createGithubIssue_(props, owner, repo, token, issue);
    if (result.ok) {
      writeGithubColumns_(sheet, rowNumber, result.url, result.number, 'created', '');
      return { status: 'created' };
    }
    writeGithubColumns_(sheet, rowNumber, '', '', 'failed', result.error);
    return { status: 'failed' };
  } catch (err) {
    writeGithubColumns_(sheet, rowNumber, '', '', 'failed', String(err));
    return { status: 'failed' };
  }
}

function writeGithubColumns_(sheet, rowNumber, url, number, status, error) {
  sheet.getRange(rowNumber, COL.githubIssueUrl, 1, 4)
    .setValues([[url, number, status, truncate_(error, 500)]]);
}

/**
 * Build the issue title and body from a Sheet row. Privacy-safe by design:
 * no screenshot image, no message thread content, no secrets. The
 * screenshot Drive link is included only when GITHUB_INCLUDE_SCREENSHOT_LINK
 * is 'true'.
 */
function buildIssueContent_(props, values) {
  function cell(name) { return String(values[COL[name] - 1] || '').trim(); }

  var reportId = cell('reportId');
  var kind = kindLabel_(cell('type'));
  var title = truncate_(cell('title') || '(no title)', 200);
  var createdAt = values[COL.createdAt - 1];
  var submittedAt = createdAt instanceof Date
    ? createdAt.toISOString()
    : String(createdAt || '');

  var lines = [];
  lines.push('**Report ID:** ' + reportId);
  lines.push('**Kind:** ' + kind);
  lines.push('**Submitted at:** ' + submittedAt);
  lines.push('**Page:** ' + (cell('page') || '(unknown)'));
  lines.push('**App version:** ' + (cell('appVersion') || '(unknown)'));
  lines.push('');
  lines.push('### What happened');
  lines.push(cell('description') || '(no description)');

  if (cell('expected')) {
    lines.push('');
    lines.push('### Expected');
    lines.push(cell('expected'));
  }

  lines.push('');
  lines.push('### Context');
  if (cell('platform')) lines.push('- Platform: ' + cell('platform'));
  if (cell('browserMode')) lines.push('- Browser mode: ' + cell('browserMode'));
  if (cell('aiHelpLevel')) lines.push('- AI help level: ' + cell('aiHelpLevel'));
  if (cell('commit')) lines.push('- Commit: ' + cell('commit'));
  if (cell('userAgent')) lines.push('- Browser / device: ' + cell('userAgent'));
  var sheetLink = sheetRowLink_(props);
  if (sheetLink) lines.push('- Sheet: ' + sheetLink + ' (find row ' + reportId + ')');

  if (cell('aiSummary') || cell('aiArea') || cell('aiSeverity')) {
    lines.push('');
    lines.push('### AI triage (best effort)');
    if (cell('aiSummary')) lines.push('- Summary: ' + cell('aiSummary'));
    if (cell('aiArea')) lines.push('- Area: ' + cell('aiArea'));
    if (cell('aiSeverity')) lines.push('- Severity: ' + cell('aiSeverity'));
    if (cell('aiRepro')) lines.push('- Repro: ' + cell('aiRepro'));
  }

  if (cell('screenshotUrl')) {
    lines.push('');
    var allowLink = String(props.getProperty('GITHUB_INCLUDE_SCREENSHOT_LINK') || '')
      .trim().toLowerCase() === 'true';
    lines.push(allowLink
      ? 'Screenshot (Drive, access controlled): ' + cell('screenshotUrl')
      : 'A screenshot was attached. See column W of the feedback Sheet.');
  }

  // Safe metadata only: ids and flags, never message content or secrets.
  var metaBlock = {
    reportId: reportId,
    kind: cell('type'),
    page: cell('page'),
    threadId: cell('threadId'),
    platform: cell('platform'),
    appVersion: cell('appVersion'),
    commit: cell('commit'),
    clientTime: cell('clientTime'),
    receivedAt: cell('receivedAt')
  };
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(metaBlock, null, 2));
  lines.push('```');

  return {
    title: '[Pilot feedback] ' + kind + ': ' + title + ' (' + reportId + ')',
    body: lines.join('\n')
  };
}

function kindLabel_(type) {
  var labels = {
    bug: 'Bug',
    feedback: 'Feedback',
    confusing: 'Confusing',
    feature_idea: 'Feature idea'
  };
  return labels[type] || (type || 'Report');
}

/** Link to the feedback Sheet. Opening it still needs Sheet access. */
function sheetRowLink_(props) {
  var id = props.getProperty('SHEET_ID');
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : '';
}

/** POST to the GitHub REST API to create one issue. */
function createGithubIssue_(props, owner, repo, token, issue) {
  var payload = { title: issue.title, body: issue.body };

  var labels = splitCsv_(props.getProperty('GITHUB_LABELS'));
  if (labels.length) payload.labels = labels;

  var assignees = splitCsv_(props.getProperty('GITHUB_ASSIGNEES'));
  if (assignees.length) payload.assignees = assignees;

  var milestone = String(props.getProperty('GITHUB_MILESTONE_NUMBER') || '').trim();
  if (milestone && !isNaN(Number(milestone))) payload.milestone = Number(milestone);

  var url = 'https://api.github.com/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/issues';

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code === 201) {
    var created = JSON.parse(text);
    return { ok: true, url: created.html_url, number: created.number };
  }
  // The token travels only as a request header; GitHub never echoes it, so
  // the response body is safe to record. Truncated to keep the Sheet tidy.
  return { ok: false, error: 'GitHub API ' + code + ': ' + truncate_(text, 400) };
}

function splitCsv_(value) {
  if (!value) return [];
  return String(value).split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function truncate_(value, max) {
  var s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Backfill. Create a GitHub issue for every row that does not have one yet.
 * Safe to run repeatedly: a row that already has an issue URL is skipped,
 * so this never creates duplicates. Run it from the Apps Script editor
 * (pick syncMissingGitHubIssues, press Run) after enabling sync, or to
 * retry rows that show 'failed'.
 */
function syncMissingGitHubIssues() {
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheets()[0];
  var last = sheet.getLastRow();
  if (last < 2) {
    Logger.log('No reports yet.');
    return;
  }
  var created = 0, skipped = 0, failed = 0;
  for (var row = 2; row <= last; row++) {
    var result = syncGithubForRow_(props, sheet, row);
    if (result.status === 'created') created++;
    else if (result.status === 'failed') failed++;
    else skipped++;
    Utilities.sleep(400);
  }
  Logger.log('GitHub backfill complete. created=' + created +
    ', skipped=' + skipped + ', failed=' + failed + '.');
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Optional: GitHub issue sync

When configured, the script opens one GitHub issue per report, straight after
the Sheet row is written, and records the result back into the row (columns X
to AA). It is entirely admin side: testers never need a GitHub account and
never see any of this.

If it is not configured, or if it fails, nothing breaks for the tester. The
report is already in the Sheet, and the app still shows them their report
number.

### Privacy: read this first

Feedback reports contain what the tester typed (a title, a description, an
optional "expected" note). They never contain message content by design. But
a tester can still type something they consider private, and **a screenshot
they attach can show real private messages**.

- **Use a private repo.** Put pilot feedback issues in a **private**
  repository, ideally one dedicated to pilot feedback. Anyone who can read the
  repo can read every report.
- **Do not use a public repo** for pilot feedback. If you do, understand that
  every issue title and body is world readable, forever, even after deletion
  (search engines and caches).
- **Screenshots are never uploaded to GitHub.** The script only ever includes
  a Drive *link*, and only when `GITHUB_INCLUDE_SCREENSHOT_LINK` is `true`. The
  image itself stays in your private Drive folder. Keep that property off (the
  default) unless you are sure who can see the repo.
- The issue body carries metadata, the page, app version, timestamp,
  browser/device, AI triage, and the tester's own words. It never carries
  secrets, auth values, cookies, message thread content, or file paths.

### Create a GitHub token (minimum permissions)

Use a **fine-grained** personal access token, scoped to **only** the feedback
repo, with the **minimum** permission needed to create issues.

1. On GitHub: your profile, **Settings, Developer settings, Personal access
   tokens, Fine-grained tokens, Generate new token**.
2. **Token name:** something like `inbox-os-pilot-feedback`.
3. **Expiration:** pick a real date (for example 90 days) and set yourself a
   reminder to rotate it.
4. **Resource owner:** the account or org that owns the feedback repo.
5. **Repository access:** choose "Only select repositories", then pick **only**
   the pilot feedback repo.
6. **Repository permissions:** set **Issues** to **Read and write**. Leave
   everything else at "No access". ("Metadata" switches to "Read-only" on its
   own; that is required and fine.)
7. **Generate token**, then copy it once. GitHub will not show it again.
8. Paste it into the Apps Script Script Property `GITHUB_TOKEN` (next section).
   Do not paste it anywhere else: not into the repo, not into `.env`, not into
   docs, not into chat, not into screenshots.

The token never leaves Google Apps Script. The app, the runner, the browser,
and this repo never see it.

### Script Properties for GitHub

Add these in Project Settings, Script properties, alongside `SECRET`,
`SHEET_ID`, and `DRIVE_FOLDER_ID`.

Required to turn sync on:

| Property | Value |
| --- | --- |
| `GITHUB_ISSUES_ENABLED` | `true` to enable, `false` (or unset) to disable |
| `GITHUB_OWNER` | the repo owner: a user or org login |
| `GITHUB_REPO` | the repo name only, not the full URL |
| `GITHUB_TOKEN` | the fine-grained token from above |

Optional:

| Property | Value |
| --- | --- |
| `GITHUB_LABELS` | comma separated, for example `pilot-feedback,needs-triage`. Each label must already exist in the repo. |
| `GITHUB_ASSIGNEES` | comma separated GitHub logins. Each must have access to the repo. |
| `GITHUB_MILESTONE_NUMBER` | a milestone number that already exists in the repo |
| `GITHUB_INCLUDE_SCREENSHOT_LINK` | `true` to include the screenshot Drive link in the issue body. Default off. Read the privacy note above before turning this on. |

With `GITHUB_ISSUES_ENABLED` unset or not `true`, the script never calls
GitHub and records `skipped` in column Z.

### Authorize and deploy

The updated script makes an external request (to GitHub), which is a new
permission, so a plain re-deploy is not enough the first time.

1. Paste the updated [script](#the-script) over the old one.
2. In the editor, pick `syncMissingGitHubIssues` in the function dropdown and
   press **Run** once.
3. Apps Script asks you to authorize new permissions, including **connecting
   to an external service** (that is the GitHub call). Review and **Allow**.
4. Re-deploy the web app (Deploy, Manage deployments, edit, New version).

### Test it

- **Sync off:** leave `GITHUB_ISSUES_ENABLED` unset. Submit a test report from
  the app. The Sheet row appears; column Z is `skipped`, column AA is
  `GitHub sync disabled`. The app shows the report number as normal.
- **Sync on:** set the four required properties, re-deploy. Submit a report.
  Within a few seconds the row has column X (issue URL), Y (issue number), and
  Z `created`. Open the URL: the issue is there.
- **Bad token:** set `GITHUB_TOKEN` to a wrong value, re-deploy, submit a
  report. The row still appears; column Z is `failed`, column AA has the
  GitHub error. The app still shows the report number: the submission still
  counts as sent.

### Backfill old rows

`syncMissingGitHubIssues()` walks the Sheet and creates an issue for every row
that does not have one yet. It is safe to run repeatedly: any row that already
has an issue URL is skipped, so it never makes duplicates. Use it to catch up
reports from before you enabled sync, or to retry rows that show `failed`.

Run it from the Apps Script editor: pick `syncMissingGitHubIssues` in the
function dropdown, press **Run**, then check **Execution log** for the
`created / skipped / failed` counts.

### Duplicate protection and its limit

Idempotency is **per Sheet row**: a row that already has an issue URL is never
synced again, so neither `doPost` nor `syncMissingGitHubIssues` can create a
second issue for the same row.

The limit: the report payload has no stable cross-request id. If a submission
is genuinely sent twice (for example a tester submits, it appears to fail, and
they submit again), the Sheet gets two rows, and each row gets its own issue.
This is rare: the runner does not retry submissions, so it only happens on a
real double submit. When it does, the Sheet stays correct (two rows, two
issues) and you can close one issue by hand.

## Notes and troubleshooting

- **Secret check.** Both handlers reject anything without the matching
  `SECRET`. Apps Script `doPost` cannot read request headers, so the runner
  sends the secret as a body field; `doGet` takes it as a `?secret=` query
  parameter. The runner adds both, the browser never sees either.
- **No message content.** The runner only ever forwards the tester's typed
  fields plus safe metadata. There is no field in the payload through which
  conversation text could arrive.
- **Screenshots** are user-attached and optional. They are stored in your
  private Drive folder; the status endpoint never returns the URL, and the
  GitHub issue body never embeds the image.
- **`status` and `note`** (columns C and D) are yours to edit in the Sheet.
  Whatever you type shows up in each tester's "Recent reports" view.
- **GitHub sync status** lives in columns X to AA and is never returned by the
  status endpoint, so testers never see it. `created` means an issue was
  opened, `skipped` means sync was off, `failed` means it was on but the
  GitHub call did not succeed (the reason is in column AA).
- **GitHub API errors** in column AA:
  - `401`: the token is wrong, expired, or revoked. Make a new fine-grained
    token.
  - `403`: the token lacks **Issues, Read and write**, is not scoped to this
    repo, or you hit a rate limit.
  - `404`: `GITHUB_OWNER` or `GITHUB_REPO` is wrong, or the token cannot see
    the repo.
  - `422`: usually a label, assignee, or milestone that does not exist in the
    repo. Create it first, or clear that optional property.
