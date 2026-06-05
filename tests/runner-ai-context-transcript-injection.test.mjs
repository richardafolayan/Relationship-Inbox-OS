import test from "node:test";
import assert from "node:assert/strict";
import {
  renderMessageBody,
  formatMessageForPrompt,
  prismaMessageToPrompt
} from "../apps/runner/dist/services/ai.js";

test("text-only messages render unchanged", () => {
  const body = renderMessageBody({ text: "Yes that works", audioTranscription: null });
  assert.equal(body, "Yes that works");
});

test("transcribed audio with no text uses the transcript as the body", () => {
  const body = renderMessageBody({
    text: "",
    audioTranscription: { status: "transcribed", transcript: "I can do Thursday afternoon." }
  });
  assert.equal(body, '[Voice message transcript: "I can do Thursday afternoon."]');
});

test("transcribed audio appends transcript alongside existing text", () => {
  const body = renderMessageBody({
    text: "[Voice note]",
    audioTranscription: { status: "transcribed", transcript: "Same time tomorrow." }
  });
  assert.equal(body, '[Voice note] [Voice message transcript: "Same time tomorrow."]');
});

test("pending transcription does not append anything", () => {
  const body = renderMessageBody({
    text: "[Voice note]",
    audioTranscription: { status: "pending", transcript: null }
  });
  assert.equal(body, "[Voice note]");
});

test("failed transcription does not append anything", () => {
  const body = renderMessageBody({
    text: "[Voice note]",
    audioTranscription: { status: "failed", transcript: null }
  });
  assert.equal(body, "[Voice note]");
});

test("skipped transcription does not append anything", () => {
  const body = renderMessageBody({
    text: "[Voice note]",
    audioTranscription: { status: "skipped", transcript: null }
  });
  assert.equal(body, "[Voice note]");
});

test("transcribed status with empty transcript falls back to plain text", () => {
  const body = renderMessageBody({
    text: "[Voice note]",
    audioTranscription: { status: "transcribed", transcript: "   " }
  });
  assert.equal(body, "[Voice note]");
});

test("formatMessageForPrompt builds speaker timestamp prefix with transcript", () => {
  const line = formatMessageForPrompt({
    direction: "IN",
    text: "",
    timestamp: "2026-05-26T14:03:00.000Z",
    audioTranscription: { status: "transcribed", transcript: "Lunch on Friday?" }
  });
  assert.equal(
    line,
    'contact (2026-05-26T14:03:00.000Z): [Voice message transcript: "Lunch on Friday?"]'
  );
});

test("formatMessageForPrompt builds operator prefix on outbound messages", () => {
  const line = formatMessageForPrompt({
    direction: "OUT",
    text: "Sounds good",
    timestamp: "2026-05-26T14:05:00.000Z",
    audioTranscription: null
  });
  assert.equal(line, "operator (2026-05-26T14:05:00.000Z): Sounds good");
});

test("prismaMessageToPrompt converts a prisma row to MessageForPrompt", () => {
  const prismaRow = {
    direction: "IN",
    text: "[Voice note]",
    timestamp: new Date("2026-05-26T14:03:00.000Z"),
    audioTranscription: {
      status: "transcribed",
      transcript: "Yes, I'm in.",
      provider: "openai",
      model: "gpt-4o-mini-transcribe"
    }
  };
  const out = prismaMessageToPrompt(prismaRow);
  assert.equal(out.direction, "IN");
  assert.equal(out.text, "[Voice note]");
  assert.equal(out.timestamp, "2026-05-26T14:03:00.000Z");
  assert.equal(out.audioTranscription.status, "transcribed");
  assert.equal(out.audioTranscription.transcript, "Yes, I'm in.");
});

test("prismaMessageToPrompt passes through string timestamps and null transcription", () => {
  const out = prismaMessageToPrompt({
    direction: "OUT",
    text: "ack",
    timestamp: "2026-05-26T14:05:00.000Z"
  });
  assert.equal(out.timestamp, "2026-05-26T14:05:00.000Z");
  assert.equal(out.audioTranscription, null);
});
