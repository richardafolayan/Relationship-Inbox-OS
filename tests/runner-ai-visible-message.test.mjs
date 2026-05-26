import test from "node:test";
import assert from "node:assert/strict";
import {
  isAiVisibleMessage,
  formatMessageForPrompt
} from "../apps/runner/dist/services/ai.js";

test("plain text bubble is visible to the AI", () => {
  assert.equal(
    isAiVisibleMessage({
      text: "Yeah Friday works",
      audioTranscription: null
    }),
    true
  );
});

test("kept-an-audio-message system events are hidden from the AI", () => {
  assert.equal(
    isAiVisibleMessage({
      text: "Seyi kept an audio message from you.",
      audioTranscription: null
    }),
    false
  );
  assert.equal(
    isAiVisibleMessage({
      text: "You kept an audio message from Lanre.",
      audioTranscription: null
    }),
    false
  );
});

test("voice bubble with a successful transcript is visible", () => {
  assert.equal(
    isAiVisibleMessage({
      text: "[Voice note]",
      audioTranscription: { status: "transcribed", transcript: "I can do Thursday" }
    }),
    true
  );
});

test("voice bubble with no transcript is hidden", () => {
  assert.equal(
    isAiVisibleMessage({
      text: "[Voice note]",
      audioTranscription: null
    }),
    false
  );
  assert.equal(
    isAiVisibleMessage({
      text: "[Voice note]",
      audioTranscription: { status: "pending", transcript: null }
    }),
    false
  );
  assert.equal(
    isAiVisibleMessage({
      text: "[Voice note]",
      audioTranscription: { status: "failed", transcript: null }
    }),
    false
  );
  assert.equal(
    isAiVisibleMessage({
      text: "[Voice note]",
      audioTranscription: { status: "skipped", transcript: null }
    }),
    false
  );
});

test("voice bubble with text and no transcript is still visible (text is real content)", () => {
  assert.equal(
    isAiVisibleMessage({
      text: "Listen to this voice note when you can!",
      audioTranscription: null
    }),
    true
  );
});

test("formatMessageForPrompt preserves operator vs contact attribution on OUT voice notes", () => {
  const line = formatMessageForPrompt({
    direction: "OUT",
    text: "",
    timestamp: "2026-05-26T14:03:00.000Z",
    audioTranscription: {
      status: "transcribed",
      transcript: "I'll send the deck tonight."
    }
  });
  assert.match(line, /^operator \(2026-/);
  assert.match(line, /\[Voice message transcript: "I'll send the deck tonight\."\]/);
});

test("formatMessageForPrompt tags inbound voice notes as contact", () => {
  const line = formatMessageForPrompt({
    direction: "IN",
    text: "",
    timestamp: "2026-05-26T14:05:00.000Z",
    audioTranscription: {
      status: "transcribed",
      transcript: "Friday works for me."
    }
  });
  assert.match(line, /^contact \(2026-/);
});
