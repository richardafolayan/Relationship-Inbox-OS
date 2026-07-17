import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const THREAD_PAGE = readFileSync(join(ROOT, "apps/dashboard/app/thread/[id]/page.tsx"), "utf8");
const SETTINGS_PAGE = readFileSync(join(ROOT, "apps/dashboard/app/settings/page.tsx"), "utf8");

test("WhatsApp AUTH_REQUIRED recovery deep-links to Platforms settings", () => {
  assert.match(THREAD_PAGE, /case "AUTH_REQUIRED"/);
  assert.match(THREAD_PAGE, /label: "Reconnect WhatsApp"/);
  assert.match(
    THREAD_PAGE,
    /label: "Reconnect WhatsApp"[\s\S]{0,160}router\.push\("\/settings#whatsapp"\)/,
    "Reconnect WhatsApp must open Settings Platforms (via #whatsapp deep link), not the default Setup tab"
  );
  assert.doesNotMatch(
    THREAD_PAGE,
    /label: "Reconnect WhatsApp"[\s\S]{0,160}router\.push\("\/settings"\)/
  );
});

test("Settings hash routing activates the Platforms section", () => {
  assert.match(SETTINGS_PAGE, /id: "platforms"/);
  assert.match(SETTINGS_PAGE, /function tabFromHash/);
  // tabFromHash accepts SettingsTabId values, so #platforms selects Platforms.
  // #whatsapp is an alias that also lands on Platforms for reconnect flows.
  assert.match(SETTINGS_PAGE, /clean === "whatsapp"/);
  assert.match(
    SETTINGS_PAGE,
    /function isSettingsTabId[\s\S]*?SETTINGS_TABS\.some\(\(tab\) => tab\.id === value\)/
  );
  assert.match(SETTINGS_PAGE, /const tab = tabFromHash\(window\.location\.hash\)/);
  assert.match(SETTINGS_PAGE, /if \(tab\) setActiveTab\(tab\)/);
  assert.match(SETTINGS_PAGE, /activeTab === "platforms"/);
  assert.match(SETTINGS_PAGE, /WhatsAppConnect/);
});

test("Settings can focus the WhatsApp connect card from deep links", () => {
  assert.match(SETTINGS_PAGE, /id="whatsapp-connect"/);
  assert.match(SETTINGS_PAGE, /window\.location\.hash === "#whatsapp"/);
  assert.match(SETTINGS_PAGE, /getElementById\("whatsapp-connect"\)/);
});
