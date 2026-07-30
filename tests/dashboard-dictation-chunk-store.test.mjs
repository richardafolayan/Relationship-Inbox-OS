import assert from "node:assert/strict";
import test from "node:test";

const {
  createMemoryDictationChunkStore,
  recoverInterruptedDictationCapture,
  removePersistedDictationCapture
} = await import("../apps/dashboard/lib/dictation-chunk-store.ts");

test("persisted dictation chunks recover once in sequence order", async () => {
  const store = createMemoryDictationChunkStore();
  await store.begin({
    id: "session-1",
    mimeType: "audio/webm",
    startedAt: 100,
    status: "recording"
  });
  await store.append("session-1", 1, new Blob(["second"]));
  await store.append("session-1", 0, new Blob(["first"]));
  await store.interrupt("session-1", "pagehide", 200);

  const recovered = await recoverInterruptedDictationCapture(store);
  assert.equal(recovered.id, "session-1");
  assert.equal(recovered.interruptionReason, "pagehide");
  assert.equal(await recovered.blob.text(), "firstsecond");

  await removePersistedDictationCapture("session-1", store);
  assert.equal(await recoverInterruptedDictationCapture(store), null);
});

test("an abruptly suspended recording is recoverable without a final status write", async () => {
  const store = createMemoryDictationChunkStore();
  await store.begin({
    id: "session-2",
    mimeType: "audio/mp4",
    startedAt: 300,
    status: "recording"
  });
  await store.append("session-2", 0, new Blob(["recoverable"]));

  const recovered = await recoverInterruptedDictationCapture(store);
  assert.equal(recovered.id, "session-2");
  assert.equal(await recovered.blob.text(), "recoverable");
});
