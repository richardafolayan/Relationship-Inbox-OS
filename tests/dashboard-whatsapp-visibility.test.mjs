import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { visibleImplementedPlatforms, IMPLEMENTED_PLATFORMS } from "../apps/dashboard/lib/risk.ts";
import { SiblingPlatformFilter } from "../apps/dashboard/components/common/sibling-platform-filter.tsx";

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
  const visible = visibleImplementedPlatforms([card({ connectedAt: null, enabled: true })]);
  assert.deepEqual([...visible], ["WHATSAPP"]);
});

test("WhatsApp is visible when the pilot build explicitly enables it", () => {
  const visible = visibleImplementedPlatforms([card({ connectedAt: null, enabled: true })]);
  assert.ok(visible.includes("WHATSAPP"));
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

test("unsupported host platforms are excluded from connected totals", () => {
  const visible = visibleImplementedPlatforms([
    { platform: "LINKEDIN", connectedAt: null, supported: true },
    { platform: "IMESSAGE", connectedAt: null, supported: false },
    { platform: "WHATSAPP", connectedAt: null, supported: true }
  ]);

  assert.deepEqual(visible, ["LINKEDIN"]);
});

test("thread page sibling filter offers WhatsApp behind the same opt-in idea (#820)", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SiblingPlatformFilter, {
      value: "all",
      siblings: [{ platform: "WHATSAPP" }],
      onChange: () => undefined
    })
  );
  assert.match(markup, /value="WHATSAPP">WhatsApp<\/option>/);
});
