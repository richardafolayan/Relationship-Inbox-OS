import test from "node:test";
import assert from "node:assert/strict";
import { permissionHelpText } from "../apps/runner/dist/scripts/imessage-permission-help.js";
import {
  accessibilityGuidance,
  automationGuidance,
  fullDiskAccessGuidance
} from "../apps/runner/dist/platforms/macos-permission-guidance.js";

test("packaged permission guidance names the Mac app and gives retryable System Settings paths", () => {
  const env = { RIOS_DESKTOP: "1" };
  assert.match(fullDiskAccessGuidance(env), /Full Disk Access.*Tovi.*quit and reopen.*retry/i);
  assert.match(automationGuidance(env), /Automation.*Messages.*Tovi.*retry/i);
  assert.match(accessibilityGuidance(env), /Accessibility.*Tovi.*retry/i);
});

test("permission help never resets TCC or asks for SIP changes", () => {
  const text = permissionHelpText({ RIOS_DESKTOP: "1" }).join("\n");
  assert.match(text, /never reset/i);
  assert.match(text, /No SIP changes/i);
  assert.doesNotMatch(text, /tccutil/);
});
