import test from "node:test";
import assert from "node:assert/strict";

const {
  isNonActionableInboundPlaceholder,
  DELETED_INBOUND_PLACEHOLDER_STRINGS
} = await import("../packages/core/src/deleted-placeholder.ts");

// --- helper-level matching ---------------------------------------------------

test("matches the LinkedIn deleted-message placeholder", () => {
  assert.equal(isNonActionableInboundPlaceholder("This message has been deleted."), true);
  assert.equal(isNonActionableInboundPlaceholder("This message has been deleted"), true);
  // Whitespace tolerance — the placeholder sometimes arrives padded.
  assert.equal(isNonActionableInboundPlaceholder("  This message has been deleted.  "), true);
});

test("matches case variations conservatively", () => {
  assert.equal(isNonActionableInboundPlaceholder("this message has been deleted."), true);
  assert.equal(isNonActionableInboundPlaceholder("THIS MESSAGE HAS BEEN DELETED"), true);
});

test("matches WhatsApp / Instagram / Apple Messages variants", () => {
  assert.equal(isNonActionableInboundPlaceholder("This message was deleted"), true);
  assert.equal(isNonActionableInboundPlaceholder("This message was deleted."), true);
  assert.equal(isNonActionableInboundPlaceholder("Message was deleted"), true);
  assert.equal(isNonActionableInboundPlaceholder("Message unsent"), true);
  assert.equal(isNonActionableInboundPlaceholder("Message unsent."), true);
});

test("does not match real messages that merely contain the word 'deleted'", () => {
  // A live message mentioning a deletion is still a real turn the
  // operator may need to respond to.
  assert.equal(
    isNonActionableInboundPlaceholder("I think you deleted the wrong file?"),
    false
  );
  assert.equal(
    isNonActionableInboundPlaceholder("Looks like this message was deleted by mistake — can you resend?"),
    false
  );
  assert.equal(
    isNonActionableInboundPlaceholder("Why has the doc been deleted?"),
    false
  );
});

test("handles null / undefined / empty input", () => {
  assert.equal(isNonActionableInboundPlaceholder(null), false);
  assert.equal(isNonActionableInboundPlaceholder(undefined), false);
  assert.equal(isNonActionableInboundPlaceholder(""), false);
  assert.equal(isNonActionableInboundPlaceholder("   "), false);
});

test("ignores ordinary inbound prose", () => {
  assert.equal(isNonActionableInboundPlaceholder("hey, can you send the doc?"), false);
  assert.equal(isNonActionableInboundPlaceholder("👍"), false);
  assert.equal(isNonActionableInboundPlaceholder("thanks!"), false);
});

// --- Prisma filter constant integrity ---------------------------------------

test("DELETED_INBOUND_PLACEHOLDER_STRINGS spells out the canonical placeholders", () => {
  // The Prisma exclusion lives at the DB layer and uses the strings
  // list (notIn equality). The helper regex must accept every spelling
  // in the list, otherwise the two layers diverge and a placeholder
  // could slip past one but not the other.
  for (const placeholder of DELETED_INBOUND_PLACEHOLDER_STRINGS) {
    assert.equal(
      isNonActionableInboundPlaceholder(placeholder),
      true,
      `helper should accept canonical placeholder: ${placeholder}`
    );
  }
});

// --- behavioural scenarios ---------------------------------------------------
//
// Mirrors the scan-queue rule: the latest *actionable* inbound is what
// drives needsReply. A deletion placeholder is ignored, so the prior
// real inbound (or none) decides. This in-test simulation is a faithful
// re-statement of what apps/runner/src/services/scan-queue.ts computes
// via Prisma aggregates — it documents the rule the production query
// implements.

function simulateNeedsReply(messages) {
  const actionableInbound = messages
    .filter((m) => m.direction === "IN" && !isNonActionableInboundPlaceholder(m.text))
    .map((m) => m.timestamp);
  const outbound = messages.filter((m) => m.direction === "OUT").map((m) => m.timestamp);
  const lastIn = actionableInbound.length ? Math.max(...actionableInbound) : null;
  const lastOut = outbound.length ? Math.max(...outbound) : null;
  if (lastIn === null) return false;
  return lastOut === null || lastIn > lastOut;
}

const t = (iso) => new Date(iso).getTime();

test("deleted placeholder after operator's last outbound does NOT mark thread as needs-reply", () => {
  // The conversation wrapped on the operator's decline; the other
  // party then unsent their final message. There is nothing owed.
  const messages = [
    { direction: "IN", text: "Hi, are you available for new design work?", timestamp: t("2026-05-08T10:00:00Z") },
    { direction: "OUT", text: "Not at the moment, thanks for reaching out.", timestamp: t("2026-05-08T11:00:00Z") },
    { direction: "IN", text: "This message has been deleted.", timestamp: t("2026-05-10T09:00:00Z") }
  ];
  assert.equal(simulateNeedsReply(messages), false);
});

test("deleted placeholder does NOT hide an earlier unanswered question", () => {
  // The other party asked a direct question, then unsent a follow-up.
  // The original question is still on the table — keep the thread
  // surfaced. (Operator hasn't replied at all to the question.)
  const messages = [
    { direction: "OUT", text: "Hey, what's the latest on the proposal?", timestamp: t("2026-05-01T10:00:00Z") },
    { direction: "IN", text: "Can you send over the revised brief by Friday?", timestamp: t("2026-05-08T10:00:00Z") },
    { direction: "IN", text: "This message has been deleted.", timestamp: t("2026-05-10T09:00:00Z") }
  ];
  assert.equal(simulateNeedsReply(messages), true);
});

test("ordinary inbound after operator's outbound still marks thread as needs-reply", () => {
  // Sanity guard — the deletion-placeholder rule must not regress the
  // basic timestamp-driven rule.
  const messages = [
    { direction: "IN", text: "Hi, any thoughts on the deck?", timestamp: t("2026-05-08T10:00:00Z") },
    { direction: "OUT", text: "Let me read it tonight.", timestamp: t("2026-05-08T18:00:00Z") },
    { direction: "IN", text: "Thanks - and one more question, can we move Friday?", timestamp: t("2026-05-09T09:00:00Z") }
  ];
  assert.equal(simulateNeedsReply(messages), true);
});

test("only-message-is-a-deleted-placeholder thread is not surfaced", () => {
  // Edge case: a brand-new thread where the very first (and only)
  // observed inbound is already the deletion placeholder. There is no
  // prior real turn to fall back on — nothing to reply to.
  const messages = [
    { direction: "IN", text: "This message has been deleted.", timestamp: t("2026-05-10T09:00:00Z") }
  ];
  assert.equal(simulateNeedsReply(messages), false);
});

test("operator OUT messages are never filtered as deleted placeholders", () => {
  // The deletion-placeholder rule applies to *inbound* only — the
  // operator unsending their own message is a separate concern and is
  // explicitly out of scope here. An operator OUT bubble whose text
  // happens to read like a placeholder still counts as their outbound.
  const messages = [
    { direction: "IN", text: "Can you confirm Friday?", timestamp: t("2026-05-08T10:00:00Z") },
    // Hypothetical: even if the operator's bubble was the literal
    // placeholder string, it would still count as their OUT and put
    // the thread into "waiting on them" rather than "needs reply".
    { direction: "OUT", text: "This message has been deleted.", timestamp: t("2026-05-08T11:00:00Z") }
  ];
  // Operator was last to speak → needsReply false.
  assert.equal(simulateNeedsReply(messages), false);
});
