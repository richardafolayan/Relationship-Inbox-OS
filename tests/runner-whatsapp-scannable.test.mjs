import test from "node:test";
import assert from "node:assert/strict";
import { isWhatsAppScannable } from "../apps/runner/dist/platforms/whatsapp/scannable.js";

// The scheduled scan loop and the ALL-platform scan expansion consult this
// gate before including WhatsApp. It must be true ONLY when the operator has
// opted in (WHATSAPP_ENABLED) AND a device is currently linked ("connected").
// Any other state (connecting, qr_ready, disconnected) means scanning would
// launch a headless whatsapp-web.js Puppeteer that parks on a QR nobody sees.

test("scannable only when enabled AND connected", () => {
  assert.equal(isWhatsAppScannable({ enabled: true, state: "connected" }), true);
});

test("not scannable while disabled, even when connected", () => {
  assert.equal(isWhatsAppScannable({ enabled: false, state: "connected" }), false);
});

test("not scannable in any non-connected state while enabled", () => {
  for (const state of ["connecting", "qr_ready", "disconnected"]) {
    assert.equal(
      isWhatsAppScannable({ enabled: true, state }),
      false,
      `expected not scannable in state=${state}`
    );
  }
});

test("not scannable when disabled and not connected", () => {
  assert.equal(isWhatsAppScannable({ enabled: false, state: "disconnected" }), false);
});
