import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);

test("route identity changes synchronously and mismatched payloads cannot render", () => {
  assert.match(source, /routeThreadIdRef\.current = threadId/);
  assert.match(source, /fresh\.id !== expectedThreadId/);
  assert.match(source, /if \(!thread \|\| thread\.id !== threadId\)/);
});

test("thread mutations require both the expected route and loaded thread identity", () => {
  assert.match(source, /function postForActiveThread/);
  assert.match(source, /if \(!isActiveThread\(expectedThreadId\)\)/);
  assert.doesNotMatch(source, /await apiPost(?:Form)?\(`\/runner\/control\/thread\/\$\{thread\.id\}\/send/);
});

test("route changes invalidate and stop every audio capture path", () => {
  assert.match(source, /voiceRecordingGenerationRef\.current \+= 1/);
  assert.match(source, /stopRecorderAndStream\(recorderRef\.current, recordingStreamRef\.current\)/);
  assert.match(source, /dictationStartGenerationRef\.current \+= 1/);
  assert.match(source, /dictationAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /dictationSessionRef\.current\?\.cancel\(\)/);
  assert.match(source, /generation === voiceRecordingGenerationRef\.current/);
});

test("route layout saves the old composer owner before restoring the new owner", () => {
  const save = source.indexOf("writeThreadComposerSession(previousOwner");
  const restore = source.indexOf("readThreadComposerSession(threadId)");
  assert.ok(save > 0);
  assert.ok(restore > save);
  assert.match(source, /composerOwnerThreadIdRef\.current = threadId/);
});
