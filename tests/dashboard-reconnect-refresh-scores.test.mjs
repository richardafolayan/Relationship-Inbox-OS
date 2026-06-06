import test from "node:test";
import assert from "node:assert/strict";
import { interpretRefreshScoresResult } from "../apps/dashboard/lib/reconnect.ts";

// Regression for X12: the Reconnect "Refresh AI scores" button typed the
// runner response as `status: "ok" | "ai_unavailable"`, so the runner's
// `disabled_by_settings` short-circuit (emitted when the operator's AI tier is
// memory_only) fell through to a neutral "Scored 0" in an "ok" tone. The
// operator turned AI off, clicked Refresh, and was told "Scored 0" as if the
// scorer ran. The Inbox "Refresh closed verdicts" sibling handles the identical
// contract correctly; interpretRefreshScoresResult now mirrors it.

test("disabled_by_settings reads as 'AI is off (Settings)' in a warn tone (the bug)", () => {
  // Runner short-circuit: scored 0 / skipped 0 with the disabled status.
  const out = interpretRefreshScoresResult({ status: "disabled_by_settings", scored: 0, skipped: 0 });
  assert.equal(out.summary, "AI is off (Settings)");
  assert.equal(out.tone, "warn");
});

test("disabled_by_settings wins even if scored/skipped look like a normal run", () => {
  // Defensive: the status is authoritative over the counts.
  const out = interpretRefreshScoresResult({ status: "disabled_by_settings", scored: 3, skipped: 2 });
  assert.equal(out.summary, "AI is off (Settings)");
  assert.equal(out.tone, "warn");
});

test("a real score reports the count in an ok tone", () => {
  const out = interpretRefreshScoresResult({ status: "ok", scored: 5, skipped: 0 });
  assert.equal(out.summary, "Scored 5");
  assert.equal(out.tone, "ok");
});

test("a real score with skips notes the skipped count", () => {
  const out = interpretRefreshScoresResult({ status: "ok", scored: 4, skipped: 6 });
  assert.equal(out.summary, "Scored 4, skipped 6 already done");
  assert.equal(out.tone, "ok");
});

test("nothing new to score reads as 'Already up to date'", () => {
  const out = interpretRefreshScoresResult({ status: "ok", scored: 0, skipped: 9 });
  assert.equal(out.summary, "Already up to date");
  assert.equal(out.tone, "ok");
});

test("ai_unavailable mid-run is a warn tone with the partial count", () => {
  const out = interpretRefreshScoresResult({ status: "ai_unavailable", scored: 2, skipped: 0 });
  assert.equal(out.summary, "Scored 2, then AI went quiet");
  assert.equal(out.tone, "warn");
});

test("disabled_by_settings is distinct from ai_unavailable copy", () => {
  // The two warn-tone statuses must not collapse to the same message: one means
  // "you switched AI off", the other "AI broke mid-run".
  const disabled = interpretRefreshScoresResult({ status: "disabled_by_settings", scored: 0, skipped: 0 });
  const unavailable = interpretRefreshScoresResult({ status: "ai_unavailable", scored: 0, skipped: 0 });
  assert.notEqual(disabled.summary, unavailable.summary);
});
