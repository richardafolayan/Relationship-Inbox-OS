import test from "node:test";
import assert from "node:assert/strict";

import { createIMessageVoiceSnapshotService } from "../apps/runner/src/services/imessage-voice-snapshot.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("deselection while attachment metadata loads prevents chat.db, snapshot and transcription", async () => {
  const entered = deferred();
  const release = deferred();
  let allowed = true;
  let databaseOpens = 0;
  let snapshots = 0;
  let enqueues = 0;
  const service = createIMessageVoiceSnapshotService({
    enabled: () => true,
    loadAttachmentsJson: async () => {
      entered.resolve();
      await release.promise;
      return JSON.stringify([{ guid: "voice-guid" }]);
    },
    openDatabase: () => {
      databaseOpens += 1;
      return {
        findAttachmentByGuid: () => ({
          absolutePath: "/private/message.caf",
          mimeType: "audio/x-caf",
          filename: "message.caf",
          transferName: "Audio Message.caf"
        }),
        close: () => undefined
      };
    },
    existingSnapshotPath: () => null,
    snapshot: () => { snapshots += 1; },
    enqueue: () => { enqueues += 1; }
  });

  const running = service.handle("message-1", async () => allowed);
  await entered.promise;
  allowed = false;
  release.resolve();
  await running;

  assert.equal(databaseOpens, 0);
  assert.equal(snapshots, 0);
  assert.equal(enqueues, 0);
});

test("selection is rechecked after snapshotting before transcription enqueue", async () => {
  let allowed = true;
  let enqueues = 0;
  const service = createIMessageVoiceSnapshotService({
    enabled: () => true,
    loadAttachmentsJson: async () => JSON.stringify([{ guid: "voice-guid" }]),
    openDatabase: () => ({
      findAttachmentByGuid: () => ({
        absolutePath: "/private/message.caf",
        mimeType: "audio/x-caf",
        filename: "message.caf",
        transferName: "Audio Message.caf"
      }),
      close: () => undefined
    }),
    existingSnapshotPath: () => null,
    snapshot: () => { allowed = false; },
    enqueue: () => { enqueues += 1; }
  });

  await service.handle("message-1", async () => allowed);
  assert.equal(enqueues, 0);
});
