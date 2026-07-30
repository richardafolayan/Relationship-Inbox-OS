import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../apps/runner/src/index.ts", import.meta.url),
  "utf8"
);

test("dictation formatting receives the voice profile, accepted outputs, and aggregate inbound proportions", () => {
  const start = source.indexOf('app.post("/control/thread/:threadId/format-dictation-messages"');
  const end = source.indexOf('app.post("/control/thread/:threadId/dictation-message-example"', start);
  const block = source.slice(start, end);
  assert.match(block, /settingsStore\.getOperatorProfile\(\)/);
  assert.match(block, /loadDictationMessageExamples\(\)/);
  assert.match(block, /preferredStyle: operatorProfile\.preferredStyle/);
  assert.match(block, /commonPhrases: operatorProfile\.commonPhrases/);
  assert.match(block, /avoidedPhrases: operatorProfile\.avoidedPhrases/);
  assert.match(block, /messageCount: nearbyInbound\.length/);
  assert.match(block, /totalCharacters: totalInboundCharacters/);
  assert.match(block, /averageCharacters:/);
  assert.doesNotMatch(block, /recentInboundMessages: nearbyInbound/);
});
