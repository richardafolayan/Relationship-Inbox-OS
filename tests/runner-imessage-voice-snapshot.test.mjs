import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  snapshotImessageVoice,
  hasImessageVoiceSnapshot,
  imessageVoiceSnapshotPath,
  imessageVoiceSnapshotMeta,
  deleteImessageVoiceSnapshot
} from "../apps/runner/dist/services/imessage-voice-store.js";
import { attachmentGuidsFromRows } from "../apps/runner/dist/services/scan-queue.js";

// These exercise the on-disk snapshot store that preserves iMessage voice
// notes before Apple's "Expire after 2 minutes" deletes them. The store keys
// snapshots by attachment guid; tests use throwaway guids and clean up after
// themselves so they never collide with real captured audio.

function uniqueGuid() {
  return `test-voice-${randomUUID()}`;
}

test("snapshotImessageVoice copies bytes and the resolver can read them back", () => {
  const guid = uniqueGuid();
  const dir = mkdtempSync(join(tmpdir(), "vn-src-"));
  const src = join(dir, "Audio Message.caf");
  writeFileSync(src, Buffer.from("fake-caf-audio-bytes"));
  try {
    assert.equal(hasImessageVoiceSnapshot(guid), false);
    const dest = snapshotImessageVoice(guid, src);
    assert.ok(dest && existsSync(dest), "snapshot file should exist");
    assert.equal(hasImessageVoiceSnapshot(guid), true);

    const meta = imessageVoiceSnapshotMeta(guid);
    assert.ok(meta);
    assert.equal(meta.mimeType, "audio/x-caf");
    assert.match(meta.filename, /\.caf$/);
    assert.equal(meta.absolutePath, imessageVoiceSnapshotPath(guid));
  } finally {
    deleteImessageVoiceSnapshot(guid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot is idempotent: a second call keeps the first capture", () => {
  const guid = uniqueGuid();
  const dir = mkdtempSync(join(tmpdir(), "vn-src-"));
  const src = join(dir, "Audio Message.caf");
  writeFileSync(src, Buffer.from("first-bytes"));
  try {
    const first = snapshotImessageVoice(guid, src);
    // Simulate Apple deleting the original, then a re-scan with the file gone.
    rmSync(src, { force: true });
    const second = snapshotImessageVoice(guid, src);
    assert.equal(second, first, "re-snapshot returns the existing path, not null");
    assert.equal(hasImessageVoiceSnapshot(guid), true);
  } finally {
    deleteImessageVoiceSnapshot(guid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot returns null when the source is already gone (expired before capture)", () => {
  const guid = uniqueGuid();
  const result = snapshotImessageVoice(guid, "/path/that/does/not/exist.caf");
  assert.equal(result, null);
  assert.equal(hasImessageVoiceSnapshot(guid), false);
});

test("deleteImessageVoiceSnapshot honours a retraction by removing the audio", () => {
  const guid = uniqueGuid();
  const dir = mkdtempSync(join(tmpdir(), "vn-src-"));
  const src = join(dir, "Audio Message.caf");
  writeFileSync(src, Buffer.from("bytes"));
  try {
    snapshotImessageVoice(guid, src);
    assert.equal(hasImessageVoiceSnapshot(guid), true);
    deleteImessageVoiceSnapshot(guid);
    assert.equal(hasImessageVoiceSnapshot(guid), false);
    assert.equal(imessageVoiceSnapshotPath(guid), null);
    // Deleting again is a safe no-op.
    deleteImessageVoiceSnapshot(guid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachmentGuidsFromRows extracts guids and tolerates malformed blobs", () => {
  const guids = attachmentGuidsFromRows([
    { attachmentsJson: JSON.stringify([{ guid: "g1" }, { guid: "g2" }]) },
    { attachmentsJson: null },
    { attachmentsJson: "not json{" },
    { attachmentsJson: JSON.stringify([{ guid: "" }, { notGuid: "x" }]) },
    { attachmentsJson: JSON.stringify([{ guid: "g3" }]) }
  ]);
  assert.deepEqual(guids, ["g1", "g2", "g3"]);
});
