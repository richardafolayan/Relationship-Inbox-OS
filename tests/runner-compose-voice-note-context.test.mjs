import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  prismaMessageToPrompt,
  renderMessageBody
} from "../apps/runner/dist/services/ai.js";

// /control/thread/:id/compose ("tell the AI what to say") and the in-place
// "rewrite in my voice" route were the only AI paths that mapped messages as
// {direction,text,timestamp}, dropping the audio transcript. On a thread whose
// last inbound is a voice note, composeInVoice then saw the bare "[Voice note]"
// placeholder and answered nothing the contact said. Both now load the
// transcript and map via prismaMessageToPrompt (the canonical mapper).

test("a transcribed voice note flows from a Prisma row into the prompt body", () => {
  const prompt = prismaMessageToPrompt({
    direction: "IN",
    text: "[Voice note]",
    timestamp: new Date("2026-05-01T10:00:00Z"),
    audioTranscription: { status: "transcribed", transcript: "Can you do Thursday?" }
  });
  assert.equal(prompt.audioTranscription?.transcript, "Can you do Thursday?");
  assert.match(renderMessageBody(prompt), /Can you do Thursday\?/);
});

test("without the transcript the prompt body is only the placeholder (the bug)", () => {
  const prompt = prismaMessageToPrompt({
    direction: "IN",
    text: "[Voice note]",
    timestamp: new Date("2026-05-01T10:00:00Z")
    // audioTranscription omitted — what the old mapping produced
  });
  assert.equal(renderMessageBody(prompt), "[Voice note]");
});

const indexSrc = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/index.ts", import.meta.url)),
  "utf8"
);

test("both composeInVoice callers map threadMessages via prismaMessageToPrompt", () => {
  const mapped = indexSrc.match(/threadMessages:\s*orderedMessages\.map\(prismaMessageToPrompt\)/g) ?? [];
  assert.equal(mapped.length, 2, "compose + rewrite routes both map via prismaMessageToPrompt");
  // The transcript-dropping manual mapping must be gone from both callers.
  assert.equal(
    indexSrc.includes("threadMessages: orderedMessages.map((m) => ({"),
    false,
    "no composeInVoice caller still uses the {direction,text,timestamp} mapping"
  );
});
