import assert from "node:assert/strict";
import test from "node:test";
import {
  formattedMessagesClipboardText,
  mergeFormattedMessages,
  splitFormattedMessage
} from "../apps/dashboard/lib/dictation-messages.ts";

test("message bubbles split at the cursor and merge back without changing wording", () => {
  const text = "Because icl I was honestly quite stuck but your feedback helped";
  const splitAt = text.indexOf(" but");
  const split = splitFormattedMessage(text, splitAt);
  assert.deepEqual(split, ["Because icl I was honestly quite stuck", "but your feedback helped"]);
  assert.equal(mergeFormattedMessages(split[0], split[1]), text);
});

test("split falls back to a nearby word boundary for mobile taps at the end", () => {
  const text = "One natural thought and another thought";
  assert.deepEqual(splitFormattedMessage(text, text.length), [
    "One natural thought",
    "and another thought"
  ]);
});

test("copy all preserves the reviewed order and bubble boundaries", () => {
  assert.equal(
    formattedMessagesClipboardText([
      { id: "2", text: "But your feedback helped a lot" },
      { id: "1", text: "And Yhh I’ll send it tmr" }
    ]),
    "But your feedback helped a lot\n\nAnd Yhh I’ll send it tmr"
  );
});
