import test from "node:test";
import assert from "node:assert/strict";
import {
  extractLinkedInThreadIdFromUrl,
  normalizeCanonicalLinkedInThreadId
} from "../apps/runner/dist/linkedin/linkedinIdentity.js";

// LI-4 regression. A urn:li:msg_thread:/fs_conversation: id can arrive either
// in the /messaging/thread/<token> path or as a conversationId/conversationUrn
// query param. Both must normalise to the SAME canonical id (lowercased URN),
// otherwise one conversation splits into two DB rows.

test("LI-4: a mixed-case URN normalises identically from the path and the query param", () => {
  // The URN matcher lowercases and stops at the base64 padding, so the
  // canonical id is the lowercased URN without trailing "==". The point of
  // the test is that BOTH positions produce the same value (before the fix the
  // path form kept its original case and split the thread).
  const urnMixed = "urn:li:msg_thread:2-ABCdef==";
  const expected = "urn:li:msg_thread:2-abcdef";
  const fromPath = extractLinkedInThreadIdFromUrl(
    `https://www.linkedin.com/messaging/thread/${encodeURIComponent(urnMixed)}/`
  );
  const fromQuery = extractLinkedInThreadIdFromUrl(
    `https://www.linkedin.com/messaging/?conversationId=${encodeURIComponent(urnMixed)}`
  );
  assert.equal(fromPath, expected);
  assert.equal(fromQuery, expected);
  assert.equal(fromPath, fromQuery);
});

test("LI-4: conversationUrn query param normalises the same as the path form", () => {
  const urn = "urn:li:fs_conversation:2-XyZ123==";
  const fromPath = extractLinkedInThreadIdFromUrl(
    `https://www.linkedin.com/messaging/thread/${encodeURIComponent(urn)}/`
  );
  const fromQuery = extractLinkedInThreadIdFromUrl(
    `https://www.linkedin.com/messaging/?conversationUrn=${encodeURIComponent(urn)}`
  );
  assert.equal(fromPath, fromQuery);
  assert.equal(fromPath, "urn:li:fs_conversation:2-xyz123");
});

test("LI-4: a non-URN numeric thread token is preserved (and case-stable) from the path", () => {
  const token = "2-ZmFrZS10aHJlYWQ";
  const id = extractLinkedInThreadIdFromUrl(`https://www.linkedin.com/messaging/thread/${token}/`);
  assert.equal(id, token);
});

test("LI-4: normalizeCanonicalLinkedInThreadId collapses path/query URN forms of one thread", () => {
  const urn = "urn:li:msg_thread:2-MiXeD==";
  const viaUrl = normalizeCanonicalLinkedInThreadId({
    threadUrl: `https://www.linkedin.com/messaging/thread/${encodeURIComponent(urn)}/?filter=unread`
  });
  const viaActiveKey = normalizeCanonicalLinkedInThreadId({
    activeKey: `https://www.linkedin.com/messaging/?conversationId=${encodeURIComponent(urn)}`
  });
  assert.equal(viaUrl, viaActiveKey);
  assert.equal(viaUrl, "urn:li:msg_thread:2-mixed");
});
