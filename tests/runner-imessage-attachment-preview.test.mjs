import test from "node:test";
import assert from "node:assert/strict";
import {
  imessageMessageBodyText,
  NON_TEXT_MESSAGE_PLACEHOLDER
} from "../apps/runner/dist/platforms/imessage-message-text.js";
import { normalizePreview } from "../apps/dashboard/lib/preview.ts";

// An attachment-only iMessage (photo / voice note / sticker with no caption)
// has empty text in chat.db. Persisting "" verbatim left a blank inbox /
// Today preview row (and a bare "You: "). The placeholder mirrors the
// LinkedIn adapter and renders as "Sent an attachment" downstream.

test("empty text + an attachment becomes the non-text placeholder", () => {
  assert.equal(imessageMessageBodyText("", 1), NON_TEXT_MESSAGE_PLACEHOLDER);
});

test("whitespace-only text + an attachment becomes the placeholder", () => {
  assert.equal(imessageMessageBodyText("   \n ", 2), NON_TEXT_MESSAGE_PLACEHOLDER);
});

test("null text + an attachment becomes the placeholder", () => {
  assert.equal(imessageMessageBodyText(null, 1), NON_TEXT_MESSAGE_PLACEHOLDER);
});

test("a caption alongside an attachment is preserved verbatim", () => {
  assert.equal(imessageMessageBodyText("look at this", 1), "look at this");
});

test("a normal text message with no attachment is unchanged", () => {
  assert.equal(imessageMessageBodyText("hey there", 0), "hey there");
});

test("empty text with NO attachment stays empty (degenerate row, not relabelled)", () => {
  assert.equal(imessageMessageBodyText("", 0), "");
  assert.equal(imessageMessageBodyText(null, 0), "");
});

test("the placeholder normalises to a human preview, not raw brackets", () => {
  assert.equal(normalizePreview(NON_TEXT_MESSAGE_PLACEHOLDER), "Sent an attachment");
});
