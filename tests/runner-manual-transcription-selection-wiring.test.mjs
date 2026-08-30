import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/runner/src/index.ts", import.meta.url),
  "utf8"
);

test("manual transcription resolves and fences the message platform", () => {
  const start = source.indexOf('app.post("/control/message/:messageId/transcribe"');
  const end = source.indexOf('app.post("/control/message/:messageId/transcription/select"', start);
  const route = source.slice(start, end);

  assert.match(route, /select:\s*\{\s*thread:\s*\{\s*select:\s*\{\s*platform:\s*true/);
  assert.match(route, /platformSelectionCoordinator\.withSelectedPlatform/);
  assert.match(route, /shouldContinue:\s*\(\)\s*=>\s*platformSelectionAllowsNewWork/);
});
