import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { buildReplyGraph, computeReplyDecor, hasReplyIntent, formatReplyCount } =
  await import("../apps/dashboard/lib/reply-threading.ts");

const __dirname = dirname(fileURLToPath(import.meta.url));

let nextId = 0;
function msg(overrides = {}) {
  nextId += 1;
  const id = overrides.id ?? `m${nextId}`;
  return {
    id,
    direction: "IN",
    platformMessageKey: `guid-${id}`,
    ...overrides
  };
}

/** Reply via the Apple-native pointer (chat.db thread_originator_guid). */
function nativeReply(parent, overrides = {}) {
  return msg({ raw: { replyToGuid: parent.platformMessageKey }, ...overrides });
}

// --- buildReplyGraph ---------------------------------------------------------

test("graph: native guid pointer resolves to the in-window parent", () => {
  const parent = msg({ direction: "OUT" });
  const child = nativeReply(parent);
  const graph = buildReplyGraph([parent, child]);
  assert.equal(graph.parentIdOf.get(child.id), parent.id);
  assert.equal(graph.replyCountByParentKey.get(`id:${parent.id}`), 1);
  assert.deepEqual(graph.replyChildIdsByParentId.get(parent.id), [child.id]);
});

test("graph: app-level replyToMessageId wins over the native guid", () => {
  const parentA = msg();
  const parentB = msg();
  const child = msg({
    replyToMessageId: parentA.id,
    raw: { replyToGuid: parentB.platformMessageKey }
  });
  const graph = buildReplyGraph([parentA, parentB, child]);
  assert.equal(graph.parentIdOf.get(child.id), parentA.id);
});

test("graph: out-of-window parents group by raw pointer", () => {
  const childA = msg({ raw: { replyToGuid: "gone-guid" } });
  const childB = msg({ raw: { replyToGuid: "gone-guid" } });
  const graph = buildReplyGraph([childA, childB]);
  assert.equal(graph.parentIdOf.has(childA.id), false);
  assert.equal(graph.parentKeyOf.get(childA.id), "guid:gone-guid");
  assert.equal(graph.parentKeyOf.get(childA.id), graph.parentKeyOf.get(childB.id));
  assert.equal(graph.replyCountByParentKey.get("guid:gone-guid"), 2);
});

test("graph: a self-citing pointer is ignored", () => {
  const weird = msg({ id: "self" });
  weird.replyToMessageId = "self";
  const graph = buildReplyGraph([weird]);
  assert.equal(graph.parentKeyOf.has("self"), false);
  assert.equal(computeReplyDecor([weird]).get("self").isReply, false);
});

test("hasReplyIntent: either pointer counts, absence does not", () => {
  assert.equal(hasReplyIntent(msg()), false);
  assert.equal(hasReplyIntent(msg({ replyToMessageId: "x" })), true);
  assert.equal(hasReplyIntent(msg({ raw: { replyToGuid: "g" } })), true);
  assert.equal(hasReplyIntent(msg({ raw: { replyToGuid: "" } })), false);
});

// --- computeReplyDecor: the Apple transcript rules ---------------------------

test("reply far from its parent: quote + curve, parent gets the link", () => {
  const parent = msg({ direction: "OUT" });
  const between = msg();
  const child = nativeReply(parent, { direction: "IN" });
  const decor = computeReplyDecor([parent, between, child]);
  const d = decor.get(child.id);
  assert.equal(d.isReply, true);
  assert.equal(d.showQuote, true);
  assert.equal(d.showCurve, true);
  assert.equal(d.parentId, parent.id);
  assert.equal(d.parentDirection, "OUT");
  // Single reply: no count between quote and bubble (Apple shows it at 2+)...
  assert.equal(d.showQuoteReplyCount, false);
  // ...but the parent itself always advertises its thread.
  assert.equal(decor.get(parent.id).replyCount, 1);
});

test("reply directly under its parent: curve only, no quote", () => {
  const parent = msg({ direction: "OUT" });
  const child = nativeReply(parent);
  const decor = computeReplyDecor([parent, child]);
  const d = decor.get(child.id);
  assert.equal(d.showQuote, false);
  assert.equal(d.showCurve, true);
  assert.equal(decor.get(parent.id).replyCount, 1);
});

test("consecutive replies to one parent: run continuation drops quote and curve", () => {
  const parent = msg({ direction: "OUT" });
  const between = msg();
  const first = nativeReply(parent);
  const second = nativeReply(parent);
  const decor = computeReplyDecor([parent, between, first, second]);
  assert.equal(decor.get(first.id).showQuote, true);
  assert.equal(decor.get(first.id).showCurve, true);
  // 2 replies: the quoted run now carries the count link too.
  assert.equal(decor.get(first.id).showQuoteReplyCount, true);
  assert.equal(decor.get(first.id).parentReplyCount, 2);
  const cont = decor.get(second.id);
  assert.equal(cont.isReply, true);
  assert.equal(cont.showQuote, false);
  assert.equal(cont.showCurve, false);
  assert.equal(decor.get(parent.id).replyCount, 2);
});

test("interleaved runs: a later reply after other traffic re-quotes", () => {
  const parent = msg({ direction: "OUT" });
  const r1 = nativeReply(parent);
  const noise = msg();
  const r2 = nativeReply(parent);
  const decor = computeReplyDecor([parent, r1, noise, r2]);
  // r1 sits directly under parent: curve only.
  assert.equal(decor.get(r1.id).showQuote, false);
  assert.equal(decor.get(r1.id).showCurve, true);
  // r2 is separated: full quote again, and the 2+ count shows on it.
  assert.equal(decor.get(r2.id).showQuote, true);
  assert.equal(decor.get(r2.id).showQuoteReplyCount, true);
  assert.equal(decor.get(r2.id).parentReplyCount, 2);
});

test("replies to different parents never merge into one run", () => {
  const parentA = msg({ direction: "OUT" });
  const parentB = msg({ direction: "OUT" });
  const childA = nativeReply(parentA);
  const childB = nativeReply(parentB);
  const decor = computeReplyDecor([parentA, parentB, childA, childB]);
  assert.equal(decor.get(childA.id).showQuote, true);
  // childB follows a reply, but to a DIFFERENT parent: it quotes too.
  assert.equal(decor.get(childB.id).showQuote, true);
  assert.equal(decor.get(childB.id).showCurve, true);
});

test("out-of-window parent: quote renders, not navigable, server direction wins", () => {
  const child = msg({
    direction: "OUT",
    raw: { replyToGuid: "outside" },
    replyTo: { snippet: "earlier text", direction: "OUT" }
  });
  const decor = computeReplyDecor([msg(), child]);
  const d = decor.get(child.id);
  assert.equal(d.isReply, true);
  assert.equal(d.showQuote, true);
  assert.equal(d.parentId, null);
  assert.equal(d.parentDirection, "OUT");
});

test("out-of-window parent without a server stub: quote leans opposite the reply", () => {
  const child = msg({ direction: "OUT", raw: { replyToGuid: "outside" } });
  const decor = computeReplyDecor([child]);
  assert.equal(decor.get(child.id).parentDirection, "IN");
});

test("out-of-window continuation still folds into one run", () => {
  const r1 = msg({ raw: { replyToGuid: "outside" } });
  const r2 = msg({ raw: { replyToGuid: "outside" } });
  const decor = computeReplyDecor([r1, r2]);
  assert.equal(decor.get(r1.id).showQuote, true);
  assert.equal(decor.get(r2.id).showQuote, false);
  assert.equal(decor.get(r2.id).showCurve, false);
});

test("reply to own message: quote leans to the replier's own side", () => {
  const parent = msg({ direction: "OUT" });
  const noise = msg();
  const child = nativeReply(parent, { direction: "OUT" });
  const decor = computeReplyDecor([parent, noise, child]);
  assert.equal(decor.get(child.id).parentDirection, "OUT");
});

test("a message can be both a reply and a parent", () => {
  const root = msg({ direction: "OUT" });
  const mid = nativeReply(root, { direction: "IN" });
  const noise = msg();
  const leaf = nativeReply(mid, { direction: "OUT" });
  const decor = computeReplyDecor([root, mid, noise, leaf]);
  const m = decor.get(mid.id);
  assert.equal(m.isReply, true);
  assert.equal(m.replyCount, 1);
  assert.equal(decor.get(leaf.id).parentId, mid.id);
});

test("formatReplyCount pluralises", () => {
  assert.equal(formatReplyCount(1), "1 Reply");
  assert.equal(formatReplyCount(2), "2 Replies");
});

// --- Esc layering (source-level wiring) --------------------------------------
// The app shell's global Escape navigates /thread/* back to /today. With the
// focused-thread overlay open, Esc must close the OVERLAY only - layered
// dismissal: palette, then overlay, then thread. The shell yields via a DOM
// presence check on the overlay's data attribute; if either side of that
// contract is renamed, this breaks loudly here instead of silently regressing
// to "Esc in a focused thread kicks you out to Today" (caught by the
// Playwright pass for #695).

test("app-shell Escape yields to an open focused-thread overlay", () => {
  const shell = readFileSync(
    join(__dirname, "..", "apps", "dashboard", "components", "layout", "app-shell.tsx"),
    "utf8"
  );
  // Scope to the Escape handler - the notification handlers elsewhere in
  // the shell also push /today and are allowed to.
  const escAt = shell.indexOf('if (event.key === "Escape")');
  assert.ok(escAt !== -1, "shell must still own the global Escape handler");
  const guardAt = shell.indexOf('data-focused-overlay="true"', escAt);
  const navAt = shell.indexOf('router.push("/today")', escAt);
  assert.ok(guardAt !== -1, "Escape handler must check for the focused-thread overlay");
  assert.ok(navAt !== -1, "Escape handler still owns the Esc-closes-thread navigation");
  assert.ok(guardAt < navAt, "overlay guard must run before the /today navigation");
});

test("thread page renders the overlay with the attribute the shell checks", () => {
  const page = readFileSync(
    join(__dirname, "..", "apps", "dashboard", "app", "thread", "[id]", "page.tsx"),
    "utf8"
  );
  assert.ok(page.includes('data-focused-overlay="true"'));
  assert.ok(page.includes("<FocusedThreadOverlay"));
});
