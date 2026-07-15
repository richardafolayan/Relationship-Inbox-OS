import test from "node:test";
import assert from "node:assert/strict";
import {
  availablePlatformNames,
  resolvePlatformAvailability
} from "../apps/runner/dist/platform-availability.js";

test("platform switches use pilot-safe defaults", () => {
  assert.deepEqual(resolvePlatformAvailability({}, "darwin"), {
    LINKEDIN: true,
    IMESSAGE: false,
    WHATSAPP: false
  });
});

test("each platform can be enabled or disabled independently", () => {
  const availability = resolvePlatformAvailability(
    {
      LINKEDIN_ENABLED: "false",
      IMESSAGE_ENABLED: "true",
      WHATSAPP_ENABLED: "1"
    },
    "darwin"
  );

  assert.deepEqual(availability, {
    LINKEDIN: false,
    IMESSAGE: true,
    WHATSAPP: true
  });
  assert.deepEqual(availablePlatformNames(availability), ["IMESSAGE", "WHATSAPP"]);
});

test("iMessage remains unavailable away from macOS", () => {
  const availability = resolvePlatformAvailability({ IMESSAGE_ENABLED: "true" }, "linux");
  assert.equal(availability.IMESSAGE, false);
});

test("common false and true spellings are accepted", () => {
  assert.equal(resolvePlatformAvailability({ LINKEDIN_ENABLED: "off" }, "darwin").LINKEDIN, false);
  assert.equal(resolvePlatformAvailability({ WHATSAPP_ENABLED: "yes" }, "darwin").WHATSAPP, true);
});
