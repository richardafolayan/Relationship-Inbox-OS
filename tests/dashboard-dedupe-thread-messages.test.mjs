import test from "node:test";
import assert from "node:assert/strict";

const {
  dedupeThreadMessages,
  threadMessageContentKey
} = await import("../apps/dashboard/lib/dedupe-thread-messages.ts");

// Issue #881: WhatsApp thread view rendered identical bubbles twice when the
// same physical message was stored under two Prisma ids (send-time key vs
// scan-time key, or missing platform id on one scrape). The render boundary
// must collapse those rows to one bubble.

function waRow(overrides = {}) {
  return {
    id: "msg-a",
    platformMessageKey: "false_447111@c.us_ABCDEF",
    direction: "IN",
    timestamp: "2026-07-17T08:03:00.000Z",
    text: "Yoo! It's July / Too early",
    senderName: "Bruce Hirwa",
    attachments: [],
    ...overrides
  };
}

test("two identical WhatsApp rows collapse to one bubble", () => {
  const rows = [
    waRow({ id: "msg-a" }),
    waRow({
      id: "msg-b",
      platformMessageKey: "stable-hash-different-key"
    })
  ];
  const out = dedupeThreadMessages(rows, "thread-fdlm");
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Yoo! It's July / Too early");
});

test("identical outbound WhatsApp rows also collapse", () => {
  const text = "🤣🤣never too early I booked annual leave for next year already lool!";
  const rows = [
    waRow({
      id: "out-1",
      direction: "OUT",
      timestamp: "2026-07-16T18:49:00.000Z",
      text,
      senderName: null,
      platformMessageKey: "true_447111@c.us_OUT1",
      sentVia: "automation"
    }),
    waRow({
      id: "out-2",
      direction: "OUT",
      timestamp: "2026-07-16T18:49:00.000Z",
      text,
      senderName: null,
      platformMessageKey: "hash-send-time-fallback"
    })
  ];
  const out = dedupeThreadMessages(rows, "thread-fdlm");
  assert.equal(out.length, 1);
  // Prefer the richer row (automation tag + real-looking platform key).
  assert.equal(out[0].id, "out-1");
  assert.equal(out[0].sentVia, "automation");
});

test("same platformMessageKey collapses even when text differs slightly", () => {
  const key = "false_447@c.us_SAME";
  const rows = [
    waRow({ id: "a", platformMessageKey: key, text: "hello" }),
    waRow({ id: "b", platformMessageKey: key, text: "hello " })
  ];
  const out = dedupeThreadMessages(rows);
  assert.equal(out.length, 1);
});

test("keeps the richer of two twins sharing a platformMessageKey (attachments win)", () => {
  // Same platform id is definitive even if one scrape only has placeholder
  // media metadata and the other has the downloaded guid.
  const key = "false_447@c.us_MEDIA_MSG";
  const rows = [
    waRow({
      id: "plain",
      platformMessageKey: key,
      text: "photo",
      attachments: [{ kind: "photo", type: "image/jpeg", manualReview: true }]
    }),
    waRow({
      id: "with-media",
      platformMessageKey: key,
      text: "photo",
      attachments: [{ guid: "false_447@c.us_MEDIA", kind: "photo", type: "image/jpeg" }]
    })
  ];
  const out = dedupeThreadMessages(rows, "t1");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "with-media");
  assert.equal(out[0].attachments[0].guid, "false_447@c.us_MEDIA");
});

test("distinct messages with different content stay", () => {
  const rows = [
    waRow({ id: "a", text: "first", timestamp: "2026-07-17T08:03:00.000Z" }),
    waRow({
      id: "b",
      text: "second",
      timestamp: "2026-07-17T08:04:00.000Z",
      platformMessageKey: "other-key"
    })
  ];
  const out = dedupeThreadMessages(rows, "t1");
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((m) => m.id),
    ["a", "b"]
  );
});

test("group: same text and timestamp from different senders stay as two bubbles", () => {
  const rows = [
    waRow({
      id: "bruce",
      text: "ok",
      timestamp: "2026-07-17T08:03:00.000Z",
      senderName: "Bruce Hirwa",
      platformMessageKey: "k-bruce"
    }),
    waRow({
      id: "alex",
      text: "ok",
      timestamp: "2026-07-17T08:03:00.000Z",
      senderName: "Alex",
      platformMessageKey: "k-alex"
    })
  ];
  const out = dedupeThreadMessages(rows, "group-thread");
  assert.equal(out.length, 2);
});

test("preserves order of first-seen survivors", () => {
  const rows = [
    waRow({ id: "1", text: "alpha", timestamp: "2026-07-17T08:00:00.000Z", platformMessageKey: "k1" }),
    waRow({ id: "2", text: "beta", timestamp: "2026-07-17T08:01:00.000Z", platformMessageKey: "k2" }),
    waRow({
      id: "1-dup",
      text: "alpha",
      timestamp: "2026-07-17T08:00:00.000Z",
      platformMessageKey: "k1-hash"
    }),
    waRow({ id: "3", text: "gamma", timestamp: "2026-07-17T08:02:00.000Z", platformMessageKey: "k3" })
  ];
  const out = dedupeThreadMessages(rows, "t1");
  assert.deepEqual(
    out.map((m) => m.id),
    ["1", "2", "3"]
  );
});

test("content key normalizes whitespace in text", () => {
  const a = threadMessageContentKey(
    waRow({ text: "hello   world\n" }),
    "thread-1"
  );
  const b = threadMessageContentKey(
    waRow({ text: "hello world", platformMessageKey: "other" }),
    "thread-1"
  );
  assert.equal(a, b);
});

test("empty / single-element lists are passthrough", () => {
  assert.deepEqual(dedupeThreadMessages([]), []);
  const one = [waRow()];
  assert.equal(dedupeThreadMessages(one).length, 1);
  assert.equal(dedupeThreadMessages(one)[0].id, "msg-a");
});
