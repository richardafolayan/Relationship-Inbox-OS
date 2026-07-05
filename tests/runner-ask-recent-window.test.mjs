import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pilot R-0084 (#751) + R-0092 (#759). The ask endpoint pulled messages
// oldest-first with a 600 cap, so on long-running relationships (681 and
// 1627 messages in the reported threads) the model never saw the recent
// conversation: a padel plan from this week came back "not recorded" and
// "what was the last thing said" was answered from February 2024. The
// window must hold the NEWEST messages, chronologically ordered, and the
// prompt must disclose the cut so older facts aren't denied outright.

const indexSource = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/index.ts", import.meta.url)),
  "utf8"
);
const aiSource = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/services/ai.ts", import.meta.url)),
  "utf8"
);

test("the ask endpoint pulls the newest messages and restores chronological order", () => {
  const askRoute = indexSource.slice(
    indexSource.indexOf('app.post("/control/person/:personId/ask"'),
    indexSource.indexOf('app.get("/data/operator-profile"')
  );
  assert.ok(askRoute.length > 0, "ask route not found");
  assert.match(askRoute, /orderBy: \{ timestamp: "desc" \}/, "must fetch newest-first");
  assert.doesNotMatch(askRoute, /orderBy: \{ timestamp: "asc" \}/, "the oldest-first window bug must not return");
  assert.match(askRoute, /\.reverse\(\)/, "must restore chronological order for the prompt");
  assert.match(askRoute, /transcriptTruncated/, "must tell the prompt when the window was cut");
});

test("askAboutPerson discloses a truncated window instead of denying older facts", () => {
  assert.match(aiSource, /transcriptTruncated\?: boolean/);
  assert.match(
    aiSource,
    /this window holds only the MOST RECENT messages/,
    "the truncation note must be in the prompt"
  );
  assert.match(aiSource, /rather than claiming it was never discussed/);
});

test("the friendship summary stitches both ends of a long history", () => {
  const route = indexSource.slice(
    indexSource.indexOf('app.post("/control/person/:personId/friendship-summary"'),
    indexSource.indexOf('app.post("/control/person/:personId/ask"')
  );
  assert.ok(route.length > 0, "friendship-summary route not found");
  // Earliest slice for how-you-know-each-other, newest slice for
  // recent-topics, deduped and chronological.
  assert.match(route, /orderBy: \{ timestamp: "asc" as const \}/);
  assert.match(route, /orderBy: \{ timestamp: "desc" as const \}/);
  assert.match(route, /newestDesc\.reverse\(\)\.filter/);
});
