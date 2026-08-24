import test from "node:test";
import assert from "node:assert/strict";
import {
  planPlatformSessionReset
} from "../apps/runner/dist/services/platform-session-reset.js";

const available = [
  "LINKEDIN",
  "INSTAGRAM",
  "TIKTOK",
  "IMESSAGE",
  "WHATSAPP",
  "GOOGLE_MESSAGES"
];

test("a shared-platform reset leaves the isolated Instagram session and row intact", () => {
  const plan = planPlatformSessionReset(available, "LINKEDIN");

  assert.equal(plan.resetSharedSession, true);
  assert.equal(plan.resetInstagramSession, false);
  assert.equal(plan.statusPlatforms.includes("INSTAGRAM"), false);
  assert.equal(plan.statusPlatforms.includes("WHATSAPP"), false);
});

test("an Instagram reset touches only the isolated Instagram session and row", () => {
  const plan = planPlatformSessionReset(available, "INSTAGRAM");

  assert.equal(plan.resetSharedSession, false);
  assert.equal(plan.resetInstagramSession, true);
  assert.deepEqual(plan.statusPlatforms, ["INSTAGRAM"]);
});

test("a global reset covers every managed browser session but not WhatsApp LocalAuth", () => {
  const plan = planPlatformSessionReset(available);

  assert.equal(plan.resetSharedSession, true);
  assert.equal(plan.resetInstagramSession, true);
  assert.equal(plan.statusPlatforms.includes("INSTAGRAM"), true);
  assert.equal(plan.statusPlatforms.includes("LINKEDIN"), true);
  assert.equal(plan.statusPlatforms.includes("WHATSAPP"), false);
});
