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

test("repeated connect requests preserve connected and QR-ready state", () => {
  const connectRoute = runner.slice(
    runner.indexOf('app.post("/control/whatsapp/connect"'),
    runner.indexOf('app.post("/control/whatsapp/refresh-qr"')
  );
  assert.match(connectRoute, /state === "connected"[\s\S]*res\.json/);
  assert.match(connectRoute, /state === "connecting" \|\| whatsappConnect\.state === "qr_ready"/);
  assert.ok(
    connectRoute.indexOf('state === "connected"') <
      connectRoute.indexOf('whatsappConnect.state = "connecting"')
  );
});

test("WhatsApp can be reset to a clean session with inline feedback", () => {
  assert.match(component, /apiPost\("\/runner\/control\/whatsapp\/reset"/);
  assert.match(component, /Reset WhatsApp/);
  assert.match(component, /Resetting\.\.\./);
  assert.match(component, /WhatsApp reset\. Connect again to get a new QR code\./);
  assert.match(component, /window\.confirm\(/);
  assert.match(runner, /app\.post\("\/control\/whatsapp\/reset"/);
  assert.match(runner, /clearPersistedWhatsAppSession/);
  assert.match(runner, /RESET_WHATSAPP_SESSION/);
});

test("WhatsApp uses connected status, last scan, primary Scan, and secondary More for reset", () => {
  assert.match(component, /text-risk-fresh/);
  assert.match(component, /Scan now/);
  assert.match(component, /scanBusy \? "Working\.\.\."/);
  assert.match(component, /data-testid="platform-connection-status"/);
  assert.match(component, /data-testid="platform-last-scan"/);
  assert.match(component, /aria-label="More actions"/);
  assert.match(component, /lastScanAt/);
  assert.doesNotMatch(component, /Scan ready/);
});
