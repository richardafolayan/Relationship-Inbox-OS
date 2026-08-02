import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioFingerprint,
  collectAudioAttachments
} from "../apps/runner/dist/services/transcription/index.js";

test("audio attachments are detected by kind", () => {
  const json = JSON.stringify([
    { type: "image", manualReview: false, kind: "photo" },
    { type: "voice_note", manualReview: false, kind: "voice_note", guid: "abc-123" },
    { type: "audio", manualReview: false, kind: "audio", guid: "def-456" }
  ]);
  const audio = collectAudioAttachments(json);
  assert.equal(audio.length, 2);
  assert.equal(audio[0].attachment.kind, "voice_note");
  assert.equal(audio[0].index, 1);
  assert.equal(audio[1].attachment.kind, "audio");
  assert.equal(audio[1].index, 2);
});

test("non-transcribable attachments are skipped (photos, pdfs, stickers)", () => {
  const json = JSON.stringify([
    { type: "image", manualReview: false, kind: "photo" },
    { type: "pdf", manualReview: false, kind: "pdf" },
    { type: "sticker", manualReview: false, kind: "sticker" }
  ]);
  assert.equal(collectAudioAttachments(json).length, 0);
});

test("video attachments are picked up alongside audio (collectAudioAttachments)", () => {
  const json = JSON.stringify([
    { type: "video", manualReview: false, kind: "video", guid: "v1" }
  ]);
  const out = collectAudioAttachments(json);
  assert.equal(out.length, 1);
  assert.equal(out[0].attachment.kind, "video");
});

test("null or malformed attachmentsJson returns empty", () => {
  assert.equal(collectAudioAttachments(null).length, 0);
  assert.equal(collectAudioAttachments("").length, 0);
  assert.equal(collectAudioAttachments("not json").length, 0);
  assert.equal(collectAudioAttachments(JSON.stringify({ not: "array" })).length, 0);
});

test("audioFingerprint folds platform key plus guid", () => {
  const fp = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-1",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  assert.equal(fp, "message-row-1|msg-1|att-abc");
});

test("audioFingerprint falls back to index when guid is missing", () => {
  const fp = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-1",
    attachmentGuid: null,
    attachmentIndex: 2
  });
  assert.equal(fp, "message-row-1|msg-1|idx-2");
});

test("audioFingerprint deduplicates same message with same guid", () => {
  const a = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-1",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  const b = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-1",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  assert.equal(a, b);
});

test("audioFingerprint differs across messages even with the same guid", () => {
  const a = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-1",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  const b = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "msg-2",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  assert.notEqual(a, b);
});

test("audioFingerprint differs across database messages when imported keys collide", () => {
  const a = buildAudioFingerprint({
    messageId: "message-row-1",
    platformMessageKey: "duplicate-import-key",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  const b = buildAudioFingerprint({
    messageId: "message-row-2",
    platformMessageKey: "duplicate-import-key",
    attachmentGuid: "att-abc",
    attachmentIndex: 0
  });
  assert.notEqual(a, b);
});
