import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeDictationMessageExamples,
  parseDictationMessageExamples
} from "../apps/runner/dist/services/dictation-message-examples.js";

test("accepted dictation outputs are normalised, deduplicated, and kept newest first", () => {
  const current = [
    { messages: ["Older example"] },
    { messages: ["  Same   wording  "] }
  ];
  const first = mergeDictationMessageExamples(current, [" Same wording "]);
  assert.deepEqual(first, [
    { messages: ["Same wording"] },
    { messages: ["Older example"] }
  ]);
  const next = mergeDictationMessageExamples(first, ["New first bubble", "New second bubble"]);
  assert.deepEqual(next[0], {
    messages: ["New first bubble", "New second bubble"]
  });
});

test("invalid or oversized stored examples fail closed to a small prompt-safe shape", () => {
  assert.deepEqual(parseDictationMessageExamples({ messages: ["not an array"] }), []);
  assert.deepEqual(parseDictationMessageExamples([{ messages: [] }]), []);
  const parsed = parseDictationMessageExamples(
    Array.from({ length: 20 }, (_, index) => ({
      messages: [` Example ${index}   with spacing `]
    }))
  );
  assert.equal(parsed.length, 12);
  assert.equal(parsed[0].messages[0], "Example 0 with spacing");
});
