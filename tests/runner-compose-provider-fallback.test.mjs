import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const aiSourcePath = resolve(process.cwd(), "apps/runner/src/services/ai.ts");

function composeInVoiceSource() {
  const source = readFileSync(aiSourcePath, "utf8");
  const start = source.indexOf("async function composeInVoice");
  assert.notEqual(start, -1, "composeInVoice must exist");
  const end = source.indexOf("\n  /**\n   * Pull explicit time hints", start);
  assert.notEqual(end, -1, "composeInVoice block boundary must stay findable");
  return source.slice(start, end);
}

test("composeInVoice uses the shared provider fallback chain", () => {
  const block = composeInVoiceSource();
  assert.match(block, /modelJson\(/, "Compose must walk the configured provider fallback chain");
  assert.doesNotMatch(
    block,
    /client\.chat\.completions\.create/,
    "Compose must not call only the active provider directly"
  );
});

test("composeInVoice only returns raw intent after every provider fails", () => {
  const block = composeInVoiceSource();
  assert.match(block, /if \(!source\?\.providerId\)/, "raw-intent fallback must be gated on all providers failing");
  assert.match(block, /source\.fellBackFromProviderId/, "successful provider fallback should be observable in logs");
});
