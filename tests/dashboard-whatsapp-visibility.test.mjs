import test from "node:test";
import assert from "node:assert/strict";
import { visibleImplementedPlatforms, IMPLEMENTED_PLATFORMS } from "../apps/dashboard/lib/risk.ts";

// WhatsApp is opt-in per operator (PR #780/#781 shipped the adapter off by
// default). The dashboard must not surface WhatsApp — in the "X/N connected"
// count, the reconnect modal, or the Inbox/Archived filter chips — to a pilot
// who never linked it. `visibleImplementedPlatforms` is the single gate: it
// keeps LinkedIn + iMessage always on and adds WhatsApp only once the operator
// has EVER connected it (connectedAt set, the same signal as #708/#710).

const card = (over = {}) => ({
  platform: "WHATSAPP",
  status: "NOT_CONNECTED",
  connectedAt: null,
  ...over
});

test("LinkedIn + iMessage are always visible, WhatsApp is not by default", () => {
  const visible = visibleImplementedPlatforms(null);
  assert.deepEqual([...visible], [...IMPLEMENTED_PLATFORMS]);
  assert.ok(visible.includes("LINKEDIN"));
  assert.ok(visible.includes("IMESSAGE"));
  assert.ok(!visible.includes("WHATSAPP"));
});

test("WhatsApp stays hidden when its card exists but was never connected", () => {
  const visible = visibleImplementedPlatforms([card({ connectedAt: null })]);
  assert.ok(!visible.includes("WHATSAPP"));
});

test("WhatsApp becomes visible once it has ever been connected", () => {
  const visible = visibleImplementedPlatforms([
    card({ status: "CONNECTED", connectedAt: "2026-07-06T10:00:00.000Z" })
  ]);
  assert.ok(visible.includes("WHATSAPP"));
});

test("WhatsApp stays visible after a disconnect if it was connected before", () => {
  // connectedAt is never cleared on disconnect (it is the durable "operator
  // uses WhatsApp" signal), so the chip and count must persist so the
  // operator can still see and reconnect it.
  const visible = visibleImplementedPlatforms([
    card({ status: "NOT_CONNECTED", connectedAt: "2026-07-06T10:00:00.000Z" })
  ]);
  assert.ok(visible.includes("WHATSAPP"));
});

test("the visible set does not mutate IMPLEMENTED_PLATFORMS", () => {
  const before = [...IMPLEMENTED_PLATFORMS];
  visibleImplementedPlatforms([
    card({ status: "CONNECTED", connectedAt: "2026-07-06T10:00:00.000Z" })
  ]);
  assert.deepEqual([...IMPLEMENTED_PLATFORMS], before);
  assert.ok(!IMPLEMENTED_PLATFORMS.includes("WHATSAPP"));
});
