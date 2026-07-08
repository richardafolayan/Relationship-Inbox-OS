import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync("apps/dashboard/components/settings/WhatsAppConnect.tsx", "utf8");
const runner = readFileSync("apps/runner/src/index.ts", "utf8");

test("WhatsApp QR-ready UI exposes a new-code action", () => {
  assert.match(component, /state === "qr_ready"[\s\S]*New QR code/);
  assert.match(component, /apiPost\("\/runner\/control\/whatsapp\/refresh-qr"/);
  assert.match(component, /Refreshing\.\.\./);
});

test("runner refreshes WhatsApp QR by resetting the session before reconnecting", () => {
  assert.match(runner, /app\.post\("\/control\/whatsapp\/refresh-qr"/);
  assert.match(runner, /closeSession\("refresh_qr"\)/);
  assert.match(runner, /qrDataUrl = null/);
  assert.match(runner, /ensureConnected\(\)/);
});
