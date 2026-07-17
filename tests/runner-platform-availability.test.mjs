import test from "node:test";
import assert from "node:assert/strict";
import {
  availablePlatformNames,
  connectedPlatformCount,
  effectivePlatformStatus,
  resolvePlatformAvailability
} from "../apps/runner/dist/platform-availability.js";

test("platform switches use pilot-safe defaults", () => {
  assert.deepEqual(resolvePlatformAvailability({}, "darwin"), {
    LINKEDIN: true,
    IMESSAGE: false,
    WHATSAPP: false,
    GOOGLE_MESSAGES: false
  });
  assert.equal(resolvePlatformAvailability({}, "win32").GOOGLE_MESSAGES, true);
});

test("platform switches still obey host operating-system support", () => {
  const availability = resolvePlatformAvailability(
    {
      LINKEDIN_ENABLED: "false",
      IMESSAGE_ENABLED: "true",
      WHATSAPP_ENABLED: "1",
      GOOGLE_MESSAGES_ENABLED: "yes"
    },
    "darwin"
  );

  assert.deepEqual(availability, {
    LINKEDIN: false,
    IMESSAGE: true,
    WHATSAPP: true,
    GOOGLE_MESSAGES: false
  });
  assert.deepEqual(availablePlatformNames(availability), ["IMESSAGE", "WHATSAPP"]);
  assert.equal(resolvePlatformAvailability({ IMESSAGE_ENABLED: "true" }, "win32").IMESSAGE, false);
  assert.equal(
    resolvePlatformAvailability({ GOOGLE_MESSAGES_ENABLED: "true" }, "win32")
      .GOOGLE_MESSAGES,
    true
  );
});

test("iMessage remains unavailable away from macOS", () => {
  const availability = resolvePlatformAvailability({ IMESSAGE_ENABLED: "true" }, "linux");
  assert.equal(availability.IMESSAGE, false);
});

test("common false and true spellings are accepted", () => {
  assert.equal(resolvePlatformAvailability({ LINKEDIN_ENABLED: "off" }, "darwin").LINKEDIN, false);
  assert.equal(resolvePlatformAvailability({ WHATSAPP_ENABLED: "yes" }, "darwin").WHATSAPP, true);
  assert.equal(resolvePlatformAvailability({ GOOGLE_MESSAGES_ENABLED: "off" }, "win32").GOOGLE_MESSAGES, false);
});

test("live WhatsApp state overrides a stale stored platform row", () => {
  assert.equal(effectivePlatformStatus("WHATSAPP", "NOT_CONNECTED", "connected"), "CONNECTED");
  assert.equal(effectivePlatformStatus("WHATSAPP", "CONNECTED", "disconnected"), "NOT_CONNECTED");
  assert.equal(effectivePlatformStatus("LINKEDIN", "CONNECTED", "disconnected"), "CONNECTED");
  assert.equal(
    connectedPlatformCount(
      ["IMESSAGE", "LINKEDIN", "WHATSAPP"],
      [
        { name: "IMESSAGE", status: "CONNECTED" },
        { name: "LINKEDIN", status: "CONNECTED" },
        { name: "WHATSAPP", status: "NOT_CONNECTED" }
      ],
      "connected"
    ),
    3
  );
});

test("WhatsApp preserves DEGRADED when runtime is connected", () => {
  assert.equal(effectivePlatformStatus("WHATSAPP", "DEGRADED", "connected"), "DEGRADED");
  assert.equal(
    connectedPlatformCount(
      ["WHATSAPP", "LINKEDIN"],
      [
        { name: "WHATSAPP", status: "DEGRADED" },
        { name: "LINKEDIN", status: "CONNECTED" }
      ],
      "connected"
    ),
    1
  );
});

test("WhatsApp preserves ERROR when runtime is connected", () => {
  assert.equal(effectivePlatformStatus("WHATSAPP", "ERROR", "connected"), "ERROR");
  assert.equal(
    connectedPlatformCount(
      ["WHATSAPP", "LINKEDIN"],
      [
        { name: "WHATSAPP", status: "ERROR" },
        { name: "LINKEDIN", status: "CONNECTED" }
      ],
      "connected"
    ),
    1
  );
});
