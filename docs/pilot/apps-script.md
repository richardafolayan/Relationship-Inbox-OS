# Pilot Feedback: Google Apps Script

The in-app feedback modal posts a report to the **local runner**, and the
runner forwards it to a **Google Apps Script web app**. The script writes a
row to a Google Sheet, saves any screenshots to Google Drive, and (optionally)
opens a GitHub issue for triage.

```
dashboard modal ──▶ runner /control/pilot-feedback ──▶ Apps Script web app
                                                         ├─ Google Sheet (one row, the source of truth)
                                                         ├─ Google Drive (screenshots, if attached)
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
   Z githubSyncStatus   AA githubSyncError   AB lastError
   ```

   Columns X to AA are written by the script; you never fill them in. Column
   AB (`lastError`) carries the most recent uncaught client error at submit
   time, when one fired. It makes vague reports ("Got an error?") actionable.
   The header labels are cosmetic (the script uses column positions), but
   adding them keeps the Sheet readable; the next submission auto-expands the
   grid to column AB, so no manual migration is needed beyond redeploying the
   script. The **first six columns are the only ones the status endpoint
   reads**, so descriptions, screenshots, and the GitHub columns can never
   leak into the tester-facing "Recent reports" view.
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
 * Tovi: pilot feedback intake.
 *
 * doPost: append a report row, save any screenshots to Drive, then (when
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
  githubSyncError: 27, lastError: 28
};
var COLUMN_COUNT = 28;

// Screenshots are committed into the repo so they are viewable straight from
// the issue body. The script embeds the in-GitHub raw file URL and also keeps
// a normal GitHub file link below it as a fallback. Files live on a dedicated
// branch under this folder, one per screenshot.
var ATTACHMENTS_DIR = 'pilot-feedback-attachments';
// Marker in issue bodies so screenshot backfill stays idempotent.
var AUTO_SCREENSHOT_MARKER = '<!-- inbox-os:pilot-screenshot -->';

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

    // A report may carry several screenshots. Save each to Drive; column W
    // holds every resulting URL, one per line.
    var screenshotUrl = '';
    var screenshots = report.screenshots || [];
    if (screenshots.length) {
      var folder = DriveApp.getFolderById(props.getProperty('DRIVE_FOLDER_ID'));
      var urls = [];
      for (var i = 0; i < screenshots.length; i++) {
        var shot = screenshots[i];
        if (!shot || !shot.base64) continue;
        var bytes = Utilities.base64Decode(shot.base64);
        var blob = Utilities.newBlob(
          bytes,
          shot.mimeType || 'image/png',
          reportId + '-' + (i + 1) + '-' + (shot.name || 'screenshot')
        );
        urls.push(folder.createFile(blob).getUrl());
      }
      screenshotUrl = urls.join('\n');
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
      screenshotUrl,                  // W screenshotUrl (one URL per line)
      // X..AA (GitHub columns) are overwritten by syncGithubForRow_ below;
      // written blank here only so the appended row reaches column AB.
      '',                             // X githubIssueUrl
      '',                             // Y githubIssueNumber
      '',                             // Z githubSyncStatus
      '',                             // AA githubSyncError
      meta.lastError || ''            // AB lastError
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
    // Commit any screenshots into the repo first, so the issue body can embed
    // them. Best effort: if embedding is off, the
    // token lacks Contents access, or an upload fails, this stays empty and
    // the body falls back to the Sheet/Drive note; the issue is still created.
    var githubScreenshots = [];
    if (screenshotEmbedEnabled_(props)) {
      try {
        githubScreenshots = uploadRowScreenshotsToGithub_(
          props, owner, repo, token,
          String(values[COL.reportId - 1] || '').trim(),
          values[COL.screenshotUrl - 1]
        );
      } catch (shotErr) {
        githubScreenshots = [];
      }
    }
    var issue = buildIssueContent_(props, values, githubScreenshots);
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
 * Build the issue title and body from a Sheet row. No message thread content
 * and no secrets, ever. When screenshots were committed into the (private)
 * repo, the body embeds each one so it is viewable straight from the issue;
 * otherwise it falls back to the Sheet/Drive note (Drive links are only
 * spelled out when GITHUB_INCLUDE_SCREENSHOT_LINK is 'true').
 */
function buildIssueContent_(props, values, githubScreenshots) {
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
  if (cell('lastError')) lines.push('- Last client error: ' + cell('lastError'));
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

  var screenshotUrls = cell('screenshotUrl');
  if (screenshotUrls) {
    lines.push('');
    var ghShots = githubScreenshots || [];
    if (ghShots.length) {
      lines.push(buildScreenshotMarkdown_(reportId, ghShots));
    } else {
      var allowLink = String(props.getProperty('GITHUB_INCLUDE_SCREENSHOT_LINK') || '')
        .trim().toLowerCase() === 'true';
      var shotCount = screenshotUrls.split('\n').filter(function (u) {
        return u.trim();
      }).length;
      var attached = shotCount === 1
        ? 'A screenshot was attached.'
        : shotCount + ' screenshots were attached.';
      lines.push(allowLink
        ? attached + ' Drive links (access controlled):\n' + screenshotUrls
        : attached + ' See column W of the feedback Sheet.');
    }
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
    lastError: cell('lastError'),
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

/* ------------------------------------------------------------------ *
 * Screenshot embedding. Commit screenshots into the repo and embed them
 * from the issue so they are viewable straight from GitHub. The bytes
 * come from Drive (the canonical store), so this works for a freshly
 * appended row and for older rows on backfill. Everything here is best
 * effort: a failure leaves the issue intact with the Sheet/Drive note
 * and never throws to the caller. Needs the token's Contents: write.
 * ------------------------------------------------------------------ */

/** Screenshot embedding is ON unless GITHUB_ATTACH_SCREENSHOTS is 'false'. */
function screenshotEmbedEnabled_(props) {
  return String(props.getProperty('GITHUB_ATTACH_SCREENSHOTS') || '')
    .trim().toLowerCase() !== 'false';
}

/** Branch the screenshots are committed to. Auto-created if missing. */
function attachmentsBranch_(props) {
  return String(props.getProperty('GITHUB_ATTACHMENTS_BRANCH') || '').trim()
    || 'pilot-feedback-attachments';
}

/** Pull the Drive file id out of a Drive file URL. */
function driveFileIdFromUrl_(url) {
  var s = String(url || '');
  var m = /\/d\/([A-Za-z0-9_-]+)/.exec(s) || /[?&]id=([A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1] : '';
}

/** File extension for a screenshot's content type. */
function extFromContentType_(mime) {
  switch (String(mime || '').toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'bin';
  }
}

/** Percent-encode each path segment but keep the slashes. */
function encodePath_(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

/** One place for the GitHub REST call shape (headers, JSON, muted errors). */
function githubFetch_(token, url, method, payloadObj) {
  var options = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    muteHttpExceptions: true
  };
  if (payloadObj) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payloadObj);
  }
  return UrlFetchApp.fetch(url, options);
}

/**
 * Ensure the attachments branch exists, creating it from the repo's default
 * branch if missing. Returns true when the branch is present (or created).
 */
function ensureGithubBranch_(owner, repo, token, branch) {
  var base = 'https://api.github.com/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  if (githubFetch_(token, base + '/git/ref/heads/' + encodeURIComponent(branch), 'get')
        .getResponseCode() === 200) {
    return true;
  }
  var repoResp = githubFetch_(token, base, 'get');
  if (repoResp.getResponseCode() !== 200) return false;
  var defaultBranch = JSON.parse(repoResp.getContentText()).default_branch || 'main';
  var defRef = githubFetch_(token, base + '/git/ref/heads/' + encodeURIComponent(defaultBranch), 'get');
  if (defRef.getResponseCode() !== 200) return false;
  var sha = JSON.parse(defRef.getContentText()).object.sha;
  var code = githubFetch_(token, base + '/git/refs', 'post', {
    ref: 'refs/heads/' + branch, sha: sha
  }).getResponseCode();
  return code === 201 || code === 422; // 422 = created by a concurrent run
}

/**
 * Create or update one file in the repo via the Contents API. Idempotent:
 * a PUT to an existing path supplies the current blob sha to update in place
 * instead of failing 422. Returns true on success.
 */
function putRepoFile_(owner, repo, token, branch, path, base64Content, message) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
    encodeURIComponent(repo) + '/contents/' + encodePath_(path);
  var sha = '';
  var head = githubFetch_(token, url + '?ref=' + encodeURIComponent(branch), 'get');
  if (head.getResponseCode() === 200) {
    var meta = JSON.parse(head.getContentText());
    if (meta && meta.sha) sha = meta.sha;
  }
  var payload = { message: message, content: base64Content, branch: branch };
  if (sha) payload.sha = sha;
  var code = githubFetch_(token, url, 'put', payload).getResponseCode();
  return code === 200 || code === 201;
}

/** GitHub blob-view URL (renders the image) for a committed file. */
function blobViewUrl_(owner, repo, branch, path) {
  return 'https://github.com/' + owner + '/' + repo +
    '/blob/' + encodeURIComponent(branch) + '/' + encodePath_(path);
}

/** In-GitHub raw file URL used for Markdown image embeds. */
function rawFileUrl_(owner, repo, branch, path) {
  return 'https://github.com/' + owner + '/' + repo +
    '/raw/' + encodeURIComponent(branch) + '/' + encodePath_(path);
}

function buildScreenshotMarkdown_(reportId, screenshots) {
  var lines = [AUTO_SCREENSHOT_MARKER, '### Screenshots'];
  for (var i = 0; i < screenshots.length; i++) {
    var shot = screenshots[i];
    var imageUrl = typeof shot === 'string' ? shot : shot.imageUrl;
    var viewUrl = typeof shot === 'string' ? shot : shot.viewUrl;
    lines.push('![Screenshot ' + (i + 1) + '](' + imageUrl + ')');
    lines.push('');
    lines.push('[Open screenshot ' + (i + 1) + ' in GitHub](' + viewUrl + ')');
    if (i < screenshots.length - 1) lines.push('');
  }
  lines.push('');
  lines.push('_Also saved to the feedback Sheet (column W, Google Drive)._');
  return lines.join('\n');
}

function appendScreenshotEmbedsToIssueBody_(body, reportId, screenshots) {
  var current = String(body || '');
  if (current.indexOf(AUTO_SCREENSHOT_MARKER) !== -1) return current;

  var block = buildScreenshotMarkdown_(reportId, screenshots);
  var fallbackPattern = /(?:A screenshot was attached\.|[0-9]+ screenshots were attached\.)(?: Drive links \(access controlled\):\n(?:https?:\/\/[^\n]+\n?)+| See column W of the feedback Sheet\.)/;
  var replaced = current.replace(fallbackPattern, block);
  if (replaced !== current) return replaced;

  var metadataStart = current.lastIndexOf('\n```json');
  if (metadataStart !== -1) {
    return current.slice(0, metadataStart) + '\n\n' + block + current.slice(metadataStart);
  }
  return current + '\n\n' + block;
}

/**
 * Commit every screenshot for a row into the repo and return the Markdown
 * image URL plus a normal GitHub file URL for each screenshot. Reads the bytes
 * from Drive using the URLs in column W, so it works for new and old rows
 * alike. Best effort.
 */
function uploadRowScreenshotsToGithub_(props, owner, repo, token, reportId, screenshotCell) {
  var driveUrls = String(screenshotCell || '').split('\n')
    .map(function (u) { return u.trim(); })
    .filter(function (u) { return u.length > 0; });
  if (!driveUrls.length) return [];
  var branch = attachmentsBranch_(props);
  if (!ensureGithubBranch_(owner, repo, token, branch)) return [];

  var screenshots = [];
  for (var i = 0; i < driveUrls.length; i++) {
    try {
      var fileId = driveFileIdFromUrl_(driveUrls[i]);
      if (!fileId) continue;
      var blob = DriveApp.getFileById(fileId).getBlob();
      var path = ATTACHMENTS_DIR + '/' + reportId + '-' + (i + 1) + '.' +
        extFromContentType_(blob.getContentType());
      var ok = putRepoFile_(
        owner, repo, token, branch, path,
        Utilities.base64Encode(blob.getBytes()),
        'chore(pilot-feedback): attach screenshot for ' + reportId
      );
      if (ok) {
        screenshots.push({
          imageUrl: rawFileUrl_(owner, repo, branch, path),
          viewUrl: blobViewUrl_(owner, repo, branch, path)
        });
      }
    } catch (err) {
      // Skip this one; the Drive link in the Sheet remains the fallback.
    }
  }
  return screenshots;
}

/** Fetch one issue so backfill can patch its existing body. */
function getGithubIssue_(owner, repo, token, issueNumber) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
    encodeURIComponent(repo) + '/issues/' + encodeURIComponent(issueNumber);
  var resp = githubFetch_(token, url, 'get');
  if (resp.getResponseCode() !== 200) return null;
  return JSON.parse(resp.getContentText());
}

/** Patch the existing issue body. Returns true on success. */
function updateGithubIssueBody_(owner, repo, token, issueNumber, body) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
    encodeURIComponent(repo) + '/issues/' + encodeURIComponent(issueNumber);
  return githubFetch_(token, url, 'patch', { body: body }).getResponseCode() === 200;
}

function deleteAutoScreenshotComments_(owner, repo, token, issueNumber) {
  var url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
    encodeURIComponent(repo) + '/issues/' + encodeURIComponent(issueNumber) +
    '/comments?per_page=100';
  var resp = githubFetch_(token, url, 'get');
  if (resp.getResponseCode() !== 200) return 0;
  var comments = JSON.parse(resp.getContentText());
  var deleted = 0;
  for (var i = 0; i < comments.length; i++) {
    var comment = comments[i];
    if (String(comment.body || '').indexOf(AUTO_SCREENSHOT_MARKER) === -1) continue;
    var deleteUrl = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' +
      encodeURIComponent(repo) + '/issues/comments/' + encodeURIComponent(comment.id);
    var code = githubFetch_(token, deleteUrl, 'delete').getResponseCode();
    if (code === 204) deleted++;
  }
  return deleted;
}

/**
 * Backfill. For every row that has a screenshot AND an existing GitHub issue,
 * commit the screenshot(s) into the repo and patch the issue body with inline
 * image embeds. Idempotent: a row whose issue body already has the marker is
 * skipped, so re-runs never duplicate the screenshot block. Old detached
 * auto-comments carrying the marker are removed best-effort after the body is
 * fixed. Run it from the editor (pick backfillScreenshotComments, press Run)
 * to catch up reports filed before screenshot embedding was on.
 */
function backfillScreenshotComments() {
  var props = PropertiesService.getScriptProperties();
  var owner = String(props.getProperty('GITHUB_OWNER') || '').trim();
  var repo = String(props.getProperty('GITHUB_REPO') || '').trim();
  var token = String(props.getProperty('GITHUB_TOKEN') || '').trim();
  if (!owner || !repo || !token) {
    Logger.log('Set GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN first.');
    return;
  }
  var sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheets()[0];
  var last = sheet.getLastRow();
  if (last < 2) { Logger.log('No reports yet.'); return; }

  var updated = 0, skipped = 0, failed = 0;
  for (var row = 2; row <= last; row++) {
    var values = sheet.getRange(row, 1, 1, COLUMN_COUNT).getValues()[0];
    var reportId = String(values[COL.reportId - 1] || '').trim();
    var issueNumber = String(values[COL.githubIssueNumber - 1] || '').trim();
    var screenshotCell = String(values[COL.screenshotUrl - 1] || '').trim();
    if (!issueNumber || !screenshotCell) { skipped++; continue; }
    try {
      var issue = getGithubIssue_(owner, repo, token, issueNumber);
      if (!issue) { failed++; continue; }
      if (String(issue.body || '').indexOf(AUTO_SCREENSHOT_MARKER) !== -1) {
        deleteAutoScreenshotComments_(owner, repo, token, issueNumber);
        skipped++;
        continue;
      }
      var screenshots = uploadRowScreenshotsToGithub_(props, owner, repo, token, reportId, screenshotCell);
      if (!screenshots.length) { failed++; continue; }
      var body = appendScreenshotEmbedsToIssueBody_(issue.body, reportId, screenshots);
      if (updateGithubIssueBody_(owner, repo, token, issueNumber, body)) {
        deleteAutoScreenshotComments_(owner, repo, token, issueNumber);
        updated++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
    }
    Utilities.sleep(400);
  }
  Logger.log('Screenshot backfill complete. updated=' + updated +
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
a tester can still type something they consider private, and **screenshots
they attach can show real private messages**.

- **Use a private repo.** Put pilot feedback issues in a **private**
  repository, ideally one dedicated to pilot feedback. Anyone who can read the
  repo can read every report.
- **Do not use a public repo** for pilot feedback. If you do, understand that
  every issue title and body is world readable, forever, even after deletion
  (search engines and caches).
- **Screenshots are committed into the repo so they are viewable in GitHub.**
  With `GITHUB_ATTACH_SCREENSHOTS` on (the default), the script commits each
  screenshot to the attachments branch and embeds it in the issue body, so
  anyone who can read the repo sees the image straight from the issue. This is
  the point, but it means **the repo must be private**, because the image bytes
  now live in it. The issue also includes an "Open screenshot" link under each
  image as a fallback. Set `GITHUB_ATTACH_SCREENSHOTS` to `false` to keep
  screenshots out of the repo entirely (Drive only), the old behaviour.
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
6. **Repository permissions:** set **Issues** to **Read and write** and
   **Contents** to **Read and write**. Leave everything else at "No access".
   ("Metadata" switches to "Read-only" on its own; that is required and fine.)
   Contents access lets the script commit each screenshot into the repo (and
   create the attachments branch) so the image is viewable straight from the
   issue. Without it, issues are still created, just without screenshot embeds.
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
| `GITHUB_INCLUDE_SCREENSHOT_LINK` | `true` to include the screenshot Drive link in the issue body. Default off. Read the privacy note above before turning this on. Ignored once screenshots are committed into the repo (below), since the issue then embeds the in-GitHub copies. |
| `GITHUB_ATTACH_SCREENSHOTS` | `true` (default) commits each screenshot into the repo and embeds it in the issue body, so it is viewable in GitHub. Set `false` to keep screenshots out of the repo (Drive only). Needs the token's **Contents: Read and write**. |
| `GITHUB_ATTACHMENTS_BRANCH` | Branch the screenshots are committed to. Default `pilot-feedback-attachments`, auto-created from the repo's default branch if missing. Keeps screenshot blobs off your main branch. |

With `GITHUB_ISSUES_ENABLED` unset or not `true`, the script never calls
GitHub and records `skipped` in column Z.

### Authorize and deploy

The script calls the GitHub API with `UrlFetchApp`. Apps Script does **not**
reliably auto-detect the scope it needs for that (`script.external_request`),
so it must be declared in the manifest. If it is missing, GitHub calls fail at
runtime with a `UrlFetchApp` permission error even though the project looks
authorized.

1. Paste the updated [script](#the-script) over the old `Code.gs`.
2. **Declare the OAuth scopes.** In Project Settings, tick **Show
   'appsscript.json' manifest file in editor**. Open `appsscript.json` and add
   an `oauthScopes` array. Leave the other fields as they already are:

   ```json
   {
     "timeZone": "Europe/London",
     "dependencies": {},
     "exceptionLogging": "STACKDRIVER",
     "runtimeVersion": "V8",
     "webapp": {
       "executeAs": "USER_DEPLOYING",
       "access": "ANYONE_ANONYMOUS"
     },
     "oauthScopes": [
       "https://www.googleapis.com/auth/spreadsheets",
       "https://www.googleapis.com/auth/drive",
       "https://www.googleapis.com/auth/script.external_request"
     ]
   }
   ```

3. In the editor, pick any function in the dropdown and press **Run** once.
   Apps Script asks you to authorize. The permissions screen must list **three**
   items: Google Sheets, Google Drive, and **Connect to an external service**.
   If the third one is missing, stop and recheck the manifest. Review and
   **Allow**.
4. Re-deploy the web app: Deploy, Manage deployments, edit (the pencil), set
   Version to **New version**, Deploy. The `/exec` URL stays the same.

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
function dropdown, press **Run**, then check **Execution log**. It logs a
summary line like `GitHub backfill complete. created=6, skipped=0, failed=0.`
`created` is new issues, `skipped` is rows already synced or with sync off,
and `failed` is rows the GitHub call did not create (reason in column AA).

To attach screenshots to issues that **already exist** (filed before screenshot
embedding was on, like the early pilot reports), pick `backfillScreenshotComments`
instead and **Run** it. For every row that has a screenshot and an issue, it
commits the screenshot into the repo and patches the existing issue body with
the same inline screenshot block used for new reports. It is idempotent: an
issue body that already has the screenshot marker is skipped, so it is safe to
re-run. If an earlier backfill posted a detached auto-comment, the function
deletes that marker-bearing comment after the issue body is fixed. It logs a
summary like
`Screenshot backfill complete. updated=6, skipped=2, failed=0.`

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
- **Screenshots** are user-attached and optional. They are always stored in
  your private Drive folder; the status endpoint never returns those URLs.
  With `GITHUB_ATTACH_SCREENSHOTS` on (the default), each screenshot is also
  committed into the repo on the attachments branch and embedded in the issue,
  so it is viewable straight from GitHub. To attach screenshots to issues
  filed before this was on, run `backfillScreenshotComments` from the editor.
- **`status` and `note`** (columns C and D) are yours to edit in the Sheet.
  Whatever you type shows up in each tester's "Recent reports" view.
- **GitHub sync status** lives in columns X to AA and is never returned by the
  status endpoint, so testers never see it. `created` means an issue was
  opened, `skipped` means sync was off, `failed` means it was on but the
  GitHub call did not succeed (the reason is in column AA).
- **GitHub calls all fail with a `UrlFetchApp` permission error** (column AA
  shows `You do not have permission to call UrlFetchApp.fetch`), even with the
  token set: the `script.external_request` scope was never granted, and Apps
  Script does not always re-prompt for it. Fix it:
  1. Confirm `appsscript.json` lists `script.external_request` in `oauthScopes`
     (see [Authorize and deploy](#authorize-and-deploy)).
  2. Revoke the script's access: open `myaccount.google.com/connections`, find
     the project by name, open it, and use **Delete all** to remove access.
  3. Back in the editor, Run any function and complete the consent fully. It
     now lists **Connect to an external service**. **Allow** it.
  4. Re-deploy, then re-run `syncMissingGitHubIssues` to retry the failed rows.
- **GitHub API errors** in column AA:
  - `401`: the token is wrong, expired, or revoked. Make a new fine-grained
    token.
  - `403`: the token lacks **Issues, Read and write**, is not scoped to this
    repo, or you hit a rate limit.
  - `404`: `GITHUB_OWNER` or `GITHUB_REPO` is wrong, or the token cannot see
    the repo.
  - `422`: usually a label, assignee, or milestone that does not exist in the
    repo. Create it first, or clear that optional property.
- **Issue created but no screenshot embeds** (the body still says "See column W
  of the feedback Sheet" even though a screenshot was attached): the token is
  missing **Contents: Read and write**, or `GITHUB_ATTACH_SCREENSHOTS` is
  `false`. Add the permission (regenerate the token if needed), re-deploy, then
  run `backfillScreenshotComments` to attach screenshots to issues already
  created.
