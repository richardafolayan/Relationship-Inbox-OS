import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRetryClientSendId,
  parseRetryAttachments
} from "../apps/runner/dist/services/send-retry.js";

test("retry id is deterministic for one failed request and advances for a failed retry child", () => {
  const original = "9e088d69-f77f-4f57-8842-68750382ca94";
  const first = deriveRetryClientSendId(original);
  assert.equal(first, deriveRetryClientSendId(original));
  assert.notEqual(first, original);
  assert.notEqual(deriveRetryClientSendId(first), first);
});

test("retry attachment recovery fails closed on malformed or incomplete metadata", () => {
  for (const malformed of [
    "{",
    JSON.stringify({ absolutePath: "/tmp/a" }),
    JSON.stringify([]),
    JSON.stringify([{ displayName: "a.jpg" }]),
    JSON.stringify([{ absolutePath: "/tmp/a.jpg", displayName: "" }])
  ]) {
    assert.throws(() => parseRetryAttachments(malformed), /attachment metadata/i);
  }
});

test("retry attachment recovery preserves every validated field", () => {
  const input = [
    {
      absolutePath: "/tmp/a.jpg",
      displayName: "a.jpg",
      mimeType: "image/jpeg",
      kind: "photo"
    }
  ];
  assert.deepEqual(parseRetryAttachments(JSON.stringify(input)), input);
  assert.equal(parseRetryAttachments(null), undefined);
});
