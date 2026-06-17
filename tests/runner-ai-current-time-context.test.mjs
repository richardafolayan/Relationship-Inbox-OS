import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentTimeContext } from "../apps/runner/dist/services/ai.js";

test("currentTimeContext includes local date/time, ISO timestamp, timezone, and passed-date guidance", () => {
  const ctx = currentTimeContext(new Date("2026-06-16T13:24:36.525Z"));

  assert.match(ctx, /CURRENT TIME CONTEXT/);
  assert.match(ctx, /Current date and time for the operator/);
  assert.match(ctx, /2026-06-16T13:24:36\.525Z/);
  assert.match(ctx, /System time zone/);
  assert.match(ctx, /relative dates and clock times/);
  assert.match(ctx, /already passed/);
  assert.match(ctx, /do not invent timing/i);
});

test("thread AI prompts all include currentTimeContext", () => {
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  const calls = source.split("currentTimeContext()").length - 1;

  assert.ok(
    calls >= 4,
    `expected currentTimeContext() in updateThreadSummary, generateSuggestedReplies, composeInVoice, and askAboutPerson, found ${calls}`
  );
});
