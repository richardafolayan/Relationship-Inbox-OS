import test from "node:test";
import assert from "node:assert/strict";

const {
  classifyFormatDictationResponse,
  deleteMessage,
  joinMessagesForCopy,
  mergeWithNext,
  moveMessage,
  remainingMessagesAfterPartialSend,
  sequentialSendProgressLabel,
  splitMessage,
  textsReadyToSend,
  updateMessageText,
  FORMAT_DICTATION_GENERIC_ERROR,
  FORMAT_DICTATION_TIMEOUT_ERROR,
  FORMAT_DICTATION_TIMEOUT_MS
} = await import("../apps/dashboard/lib/dictation-messages.ts");

// #880: client-side response validation + pure bubble operations for the
// review UI (edit / delete / split / merge / reorder / copy-all).

test("classifyFormatDictationResponse: ok shape → messages", () => {
  const out = classifyFormatDictationResponse({
    ok: true,
    status: 200,
    data: {
      ok: true,
      cleanedTranscript: "cleaned",
      messages: [
        { id: "message-1", text: "Btw thanks" },
        { id: "message-2", text: "Because icl I was stuck" }
      ],
      warnings: [{ originalText: "leaky", reason: "unclear" }]
    }
  });
  assert.equal(out.kind, "ok");
  assert.equal(out.cleanedTranscript, "cleaned");
  assert.equal(out.messages.length, 2);
  assert.equal(out.warnings.length, 1);
});

test("classifyFormatDictationResponse: empty messages → error, keep transcript path", () => {
  const out = classifyFormatDictationResponse({
    ok: true,
    status: 200,
    data: { ok: true, messages: [] }
  });
  assert.equal(out.kind, "error");
  assert.equal(out.message, FORMAT_DICTATION_GENERIC_ERROR);
});

test("classifyFormatDictationResponse: 502 with server error text", () => {
  const out = classifyFormatDictationResponse({
    ok: false,
    status: 502,
    data: {
      ok: false,
      error: "Could not format the transcript into messages. Your original transcript is still available."
    }
  });
  assert.equal(out.kind, "error");
  assert.match(out.message, /original transcript is still available/i);
});

test("classifyFormatDictationResponse: drops blank message texts", () => {
  const out = classifyFormatDictationResponse({
    ok: true,
    status: 200,
    data: {
      messages: [
        { id: "message-1", text: "  " },
        { id: "message-2", text: "Real one" }
      ]
    }
  });
  assert.equal(out.kind, "ok");
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].text, "Real one");
});

const sample = () => [
  { id: "message-1", text: "First thought" },
  { id: "message-2", text: "Second thought" },
  { id: "message-3", text: "Third thought" }
];

test("updateMessageText edits one bubble", () => {
  const next = updateMessageText(sample(), "message-2", "Edited");
  assert.equal(next[1].text, "Edited");
  assert.equal(next[0].text, "First thought");
});

test("deleteMessage removes and renumbers", () => {
  const next = deleteMessage(sample(), "message-2");
  assert.equal(next.length, 2);
  assert.equal(next[0].id, "message-1");
  assert.equal(next[1].id, "message-2");
  assert.equal(next[1].text, "Third thought");
});

test("splitMessage at caret produces two bubbles", () => {
  const msgs = [{ id: "message-1", text: "Hello world there" }];
  const next = splitMessage(msgs, "message-1", 5);
  assert.equal(next.length, 2);
  assert.equal(next[0].text, "Hello");
  assert.equal(next[1].text, "world there");
  assert.equal(next[0].id, "message-1");
  assert.equal(next[1].id, "message-2");
});

test("splitMessage with empty half collapses", () => {
  const msgs = [{ id: "message-1", text: "Only" }];
  assert.equal(splitMessage(msgs, "message-1", 0)[0].text, "Only");
  assert.equal(splitMessage(msgs, "message-1", 4)[0].text, "Only");
});

test("mergeWithNext joins adjacent texts", () => {
  const next = mergeWithNext(sample(), "message-1");
  assert.equal(next.length, 2);
  assert.equal(next[0].text, "First thought Second thought");
  assert.equal(next[1].text, "Third thought");
});

test("mergeWithNext on last message is a no-op", () => {
  const msgs = sample();
  assert.deepEqual(mergeWithNext(msgs, "message-3"), msgs);
});

test("moveMessage reorders up and down", () => {
  const up = moveMessage(sample(), "message-2", "up");
  assert.equal(up[0].text, "Second thought");
  assert.equal(up[1].text, "First thought");
  const down = moveMessage(sample(), "message-2", "down");
  assert.equal(down[1].text, "Third thought");
  assert.equal(down[2].text, "Second thought");
});

test("moveMessage at edges is a no-op", () => {
  const msgs = sample();
  assert.deepEqual(moveMessage(msgs, "message-1", "up"), msgs);
  assert.deepEqual(moveMessage(msgs, "message-3", "down"), msgs);
});

test("joinMessagesForCopy joins with blank lines", () => {
  assert.equal(
    joinMessagesForCopy(sample()),
    "First thought\n\nSecond thought\n\nThird thought"
  );
  assert.equal(joinMessagesForCopy([{ id: "message-1", text: "  " }]), "");
});

test("textsReadyToSend drops blanks and preserves order", () => {
  assert.deepEqual(
    textsReadyToSend([
      { id: "message-1", text: "  One  " },
      { id: "message-2", text: "   " },
      { id: "message-3", text: "Two" }
    ]),
    ["One", "Two"]
  );
});

test("sequentialSendProgressLabel is 1-based and clamp-safe", () => {
  assert.equal(sequentialSendProgressLabel(1, 3), "Sending 1 of 3…");
  assert.equal(sequentialSendProgressLabel(3, 3), "Sending 3 of 3…");
  assert.equal(sequentialSendProgressLabel(0, 2), "Sending 0 of 2…");
  assert.equal(sequentialSendProgressLabel(9, 2), "Sending 2 of 2…");
});

test("remainingMessagesAfterPartialSend keeps only unsent bubbles", () => {
  const remaining = remainingMessagesAfterPartialSend(sample(), 1);
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, "message-1");
  assert.equal(remaining[0].text, "Second thought");
  assert.equal(remaining[1].text, "Third thought");
  assert.deepEqual(remainingMessagesAfterPartialSend(sample(), 3), []);
  assert.deepEqual(remainingMessagesAfterPartialSend(sample(), 0).map((m) => m.text), [
    "First thought",
    "Second thought",
    "Third thought"
  ]);
});

test("format timeout constants are finite and user-facing", () => {
  assert.ok(FORMAT_DICTATION_TIMEOUT_MS > 0);
  assert.ok(FORMAT_DICTATION_TIMEOUT_MS <= 120_000);
  assert.match(FORMAT_DICTATION_TIMEOUT_ERROR, /took too long/i);
  assert.match(FORMAT_DICTATION_TIMEOUT_ERROR, /original transcript/i);
});

// Source-level: sequential send must snapshot the start thread and gate UI
// writes (full assertions live in dashboard-thread-page-state-race-guards).
test("thread page sequential send guards against cross-thread UI pollution", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, "..", "apps", "dashboard", "app", "thread", "[id]", "page.tsx"), "utf8");
  const sendBlock = src.slice(
    src.indexOf("const sendDictationMessagesSequentially"),
    src.indexOf("const startDictation")
  );
  assert.match(sendBlock, /const startThreadId = threadId;/);
  assert.match(
    sendBlock,
    /shouldApplyThreadScopedResult\(startThreadId, transformRouteIdRef\.current\)/
  );
  assert.ok(
    (sendBlock.match(/if \(!stillOnStartThread\(\)\) return;/g) || []).length >= 3,
    "expected multiple stillOnStartThread abort points in the send loop"
  );
});
