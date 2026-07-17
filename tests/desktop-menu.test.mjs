import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// R-0104 / #822: the desktop menu bar was the bare Electron default (app
// menu + Edit/View/Window). The buildout adds Go (sidebar navigation),
// View Back/Forward/Reload, and a Help menu with the feedback entry
// points. main.cjs runs only inside Electron, so these are structural
// pins over the template source.

const mainSource = () =>
  readFile(new URL("../apps/desktop/main.cjs", import.meta.url), "utf8");

test("Go menu mirrors the sidebar navigation", async () => {
  const source = await mainSource();
  assert.match(source, /label: "Go"/);
  for (const [label, path] of [
    ["Today", "/today"],
    ["Inbox", "/inbox"],
    ["Reconnect", "/reconnect"],
    ["Archived", "/archived"]
  ]) {
    assert.match(
      source,
      new RegExp(`label: "${label}".*openDashboardPath\\("${path}"\\)`),
      `Go > ${label} should navigate to ${path}`
    );
  }
});

test("View menu offers Back / Forward / Reload as escape hatches", async () => {
  const source = await mainSource();
  assert.match(source, /label: "Back", accelerator: "CommandOrControl\+\["/);
  assert.match(source, /label: "Forward", accelerator: "CommandOrControl\+\]"/);
  assert.match(source, /role: "reload"/);
  // History navigation guards on canGoBack/canGoForward so Back can't land
  // on the data: loading screen.
  assert.match(source, /canGoBack\(\)/);
  assert.match(source, /canGoForward\(\)/);
});

test("Back/Forward only walk local dashboard history and drop the startup page", async () => {
  const source = await mainSource();
  // #891: after dashboard load, clear history so the data: bootstrap screen
  // is not a reachable Back target; goInHistory also refuses non-dashboard URLs.
  assert.match(source, /function dropBootstrapHistory\(/);
  assert.match(source, /navigationHistory\.clear\(\)/);
  assert.match(
    source,
    /await window\.loadURL\(url\);\s*dropBootstrapHistory\(window\);/s
  );
  assert.match(source, /function goInHistory\(direction\)/);
  assert.match(source, /historyEntryAtOffset\(history, -1\)/);
  assert.match(source, /historyEntryAtOffset\(history, 1\)/);
  assert.match(source, /isLocalDashboardUrl\(previous\.url, process\.env\)/);
  assert.match(source, /isLocalDashboardUrl\(next\.url, process\.env\)/);
  assert.match(source, /isLocalDashboardUrl,/);
});

test("Help menu opens the in-app feedback modal via the pilot event", async () => {
  const source = await mainSource();
  assert.match(source, /label: "Help"/);
  assert.match(
    source,
    /Send Feedback\.\.\..*dispatchInApp\("pilot-feedback-open", \{ type: "feedback" \}\)/
  );
  assert.match(
    source,
    /Report a Bug\.\.\..*dispatchInApp\("pilot-feedback-open", \{ type: "bug" \}\)/
  );
  // The event payload is JSON-serialised into the page — no template
  // interpolation of raw strings.
  assert.match(source, /JSON\.stringify\(eventName\)/);
  assert.match(source, /JSON\.stringify\(detail \?\? null\)/);
});

test("Favourites menu lists pinned contacts and links to their thread", async () => {
  const source = await mainSource();
  assert.match(source, /label: "Favourites"/);
  // Empty state until the first runner fetch lands.
  assert.match(source, /label: "No favourites yet", enabled: false/);
  // A favourite opens its most-recent thread, or falls back to an inbox
  // search by name when it has none.
  assert.match(source, /openDashboardPath\(`\/thread\/\$\{encodeURIComponent\(contact\.threadId\)\}`\)/);
  assert.match(source, /openDashboardPath\(`\/inbox\?q=\$\{encodeURIComponent\(contact\.name\)\}`\)/);
  // Fetched from the runner's favourites endpoint and capped at five.
  assert.match(source, /getRunnerJson\("\/data\/favourites"\)/);
  assert.match(source, /\.slice\(0, 5\)/);
  assert.match(source, /label: "All People\.\.\."/);
});

test("Favourites refresh is wired to load, focus and a background poll", async () => {
  const source = await mainSource();
  // Rebuild only when the list actually changed (no menu churn on every poll).
  assert.match(source, /JSON\.stringify\(next\) === JSON\.stringify\(favouriteContacts\)/);
  assert.match(source, /mainWindow\.on\("focus"/);
  assert.match(source, /setInterval\(/);
  assert.match(source, /MENU_REFRESH_INTERVAL_MS/);
});

test("Text Size menu drives the shared in-app UI scale", async () => {
  const source = await mainSource();
  assert.match(source, /label: "Text Size"/);
  assert.match(source, /label: "Bigger", accelerator: "CommandOrControl\+="/);
  assert.match(source, /label: "Smaller", accelerator: "CommandOrControl\+-"/);
  assert.match(source, /label: "Actual Size", accelerator: "CommandOrControl\+0"/);
  // Radio items reflect the current level.
  assert.match(source, /type: "radio"/);
  assert.match(source, /checked: currentTextSize === value/);
  // It must speak the SAME localStorage key + change event as the dashboard
  // lib (apps/dashboard/lib/ui-scale.ts), or Settings and the menu diverge.
  assert.match(source, /UI_SCALE_STORAGE_KEY = "inbox_os_ui_scale"/);
  assert.match(source, /UI_SCALE_CHANGE_EVENT = "inbox-ui-scale"/);
  // Prefer the renderer bridge so the Settings control stays in sync.
  assert.match(source, /window\.__toviUiScale/);
});

test("Go menu adds People and a Settings-sections submenu", async () => {
  const source = await mainSource();
  assert.match(source, /label: "People", accelerator: "CommandOrControl\+5".*openDashboardPath\("\/people"\)/);
  for (const [label, hash] of [
    ["Platforms", "platforms"],
    ["Notifications", "notifications"],
    ["Reply Style", "writing"],
    ["Focus", "focus"],
    ["App & Updates", "app"]
  ]) {
    assert.match(
      source,
      new RegExp(`label: "${label}".*openDashboardPath\\("/settings#${hash}"\\)`),
      `Settings submenu should deep-link ${label} -> /settings#${hash}`
    );
  }
});
