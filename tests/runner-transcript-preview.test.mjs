import test from "node:test";
import assert from "node:assert/strict";
import {
  isVoicePlaceholderText,
  previewFromTranscript,
  propagateTranscriptToThreadPreview
} from "../apps/runner/dist/services/transcript-preview.js";

// Pilot R-0093 (#760): a transcribed voice note's transcript must replace the
// "[Voice note]" placeholder in the thread's inbox/Today preview.

test("voice placeholder detection matches describeAttachments audio shapes", () => {
  for (const text of [
    "[Voice note]",
    "[2 Voice notes]",
    "[Voice note, Photo]",
    "[Audio]",
    "[voice message]",
    "You sent a voice message",
    "  [Voice note]  "
  ]) {
    assert.equal(isVoicePlaceholderText(text), true, `expected placeholder: ${text}`);
  }
});

test("voice placeholder detection leaves real content alone", () => {
  for (const text of [
    "",
    null,
    undefined,
    "[Photo]",
    "[2 Photos, Video]",
    "[non-text message]",
    "[system event]",
    "listen to this [Voice note]",
    "See you at padel next saturday",
    "I sent you a voice message earlier, did you get it?"
  ]) {
    assert.equal(isVoicePlaceholderText(text), false, `expected NOT placeholder: ${String(text)}`);
  }
});

test("previewFromTranscript collapses whitespace", () => {
  assert.equal(previewFromTranscript("hey,\n  are we   still on?"), "hey, are we still on?");
});

function makeDb(state) {
  const updates = [];
  return {
    updates,
    messageAudioTranscription: {
      findUnique: async () => state.transcription ?? null
    },
    message: {
      findUnique: async () => state.message ?? null
    },
    thread: {
      findUnique: async () => state.thread ?? null,
      update: async (args) => {
        updates.push(args);
        return {};
      }
    }
  };
}

const NOW = new Date("2026-07-05T10:00:00Z");
const EARLIER = new Date("2026-07-05T09:00:00Z");

test("propagates the transcript when the voice note is the newest message", async () => {
  const db = makeDb({
    transcription: { status: "transcribed", transcript: " Padel is on Saturday at 10. " },
    message: { threadId: "t1", timestamp: NOW, text: "[Voice note]" },
    thread: { lastMessageAt: NOW }
  });
  const result = await propagateTranscriptToThreadPreview(db, "m1");
  assert.deepEqual(result, { updated: true, threadId: "t1" });
  assert.equal(db.updates.length, 1);
  assert.deepEqual(db.updates[0], {
    where: { id: "t1" },
    data: { lastMessagePreview: "Padel is on Saturday at 10." }
  });
});

test("skips when a newer message owns the preview", async () => {
  const db = makeDb({
    transcription: { status: "transcribed", transcript: "old voice note" },
    message: { threadId: "t1", timestamp: EARLIER, text: "[Voice note]" },
    thread: { lastMessageAt: NOW }
  });
  const result = await propagateTranscriptToThreadPreview(db, "m1");
  assert.equal(result.updated, false);
  assert.equal(db.updates.length, 0);
});

test("skips captioned messages - the caption stays as the preview", async () => {
  const db = makeDb({
    transcription: { status: "transcribed", transcript: "voice content" },
    message: { threadId: "t1", timestamp: NOW, text: "check this out" },
    thread: { lastMessageAt: NOW }
  });
  const result = await propagateTranscriptToThreadPreview(db, "m1");
  assert.equal(result.updated, false);
  assert.equal(db.updates.length, 0);
});

test("skips pending / failed / empty transcripts", async () => {
  for (const transcription of [
    null,
    { status: "pending", transcript: null },
    { status: "failed", transcript: null },
    { status: "transcribed", transcript: "   " }
  ]) {
    const db = makeDb({
      transcription,
      message: { threadId: "t1", timestamp: NOW, text: "[Voice note]" },
      thread: { lastMessageAt: NOW }
    });
    const result = await propagateTranscriptToThreadPreview(db, "m1");
    assert.equal(result.updated, false);
    assert.equal(db.updates.length, 0);
  }
});

test("tier upgrades overwrite a previously-propagated preview", async () => {
  // The current preview already holds the fast-tier transcript; the message
  // text is still the placeholder, so the better transcript wins again.
  const db = makeDb({
    transcription: { status: "transcribed", transcript: "Padel is on Saturday at ten, bring rackets." },
    message: { threadId: "t1", timestamp: NOW, text: "[Voice note]" },
    thread: { lastMessageAt: NOW }
  });
  const result = await propagateTranscriptToThreadPreview(db, "m1");
  assert.equal(result.updated, true);
  assert.equal(
    db.updates[0].data.lastMessagePreview,
    "Padel is on Saturday at ten, bring rackets."
  );
});
