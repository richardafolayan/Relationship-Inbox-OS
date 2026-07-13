import test from "node:test";
import assert from "node:assert/strict";
import { visibleImplementedPlatforms, IMPLEMENTED_PLATFORMS } from "../apps/dashboard/lib/risk.ts";

// The runner's /data/platforms response is the availability boundary. The
// dashboard must mirror that exact set, including an enabled platform that
// has not been connected yet and excluding a platform disabled in .env.

const card = (over = {}) => ({
  platform: "WHATSAPP",
  status: "NOT_CONNECTED",
  connectedAt: null,
  ...over
});

test("older runners without platform data keep the legacy LinkedIn and iMessage fallback", () => {
  const visible = visibleImplementedPlatforms(null);
  assert.deepEqual([...visible], [...IMPLEMENTED_PLATFORMS]);
  assert.ok(visible.includes("LINKEDIN"));
  assert.ok(visible.includes("IMESSAGE"));
  assert.ok(!visible.includes("WHATSAPP"));
});

test("WhatsApp is visible when the runner exposes it, before first connect", () => {
  const visible = visibleImplementedPlatforms([card({ connectedAt: null })]);
  assert.deepEqual([...visible], ["WHATSAPP"]);
});

test("WhatsApp becomes visible once it has ever been connected", () => {
  const visible = visibleImplementedPlatforms([
    card({ status: "CONNECTED", connectedAt: "2026-07-06T10:00:00.000Z" })
  ]);
  assert.ok(visible.includes("WHATSAPP"));
});

test("disabled platforms are absent even if other platforms are available", () => {
  const visible = visibleImplementedPlatforms([
    card({ platform: "LINKEDIN" })
  ]);
  assert.deepEqual([...visible], ["LINKEDIN"]);
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
