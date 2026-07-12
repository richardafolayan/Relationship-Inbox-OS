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
