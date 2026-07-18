import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const optional = readFileSync(
  "apps/dashboard/components/settings/OptionalComponents.tsx",
  "utf8"
);
const settings = readFileSync("apps/dashboard/app/settings/page.tsx", "utf8");
const platforms = readFileSync("apps/dashboard/app/platforms/page.tsx", "utf8");
const whatsapp = readFileSync(
  "apps/dashboard/components/settings/WhatsAppConnect.tsx",
  "utf8"
);
const platformSetup = readFileSync(
  "apps/dashboard/lib/platform-setup.ts",
  "utf8"
);

test("binary optional settings use a switch, not an On/Off pill", () => {
  assert.match(optional, /role="switch"/);
  assert.match(optional, /aria-checked=\{aiOn\}/);
  assert.match(optional, /aria-label="AI help"/);
  assert.doesNotMatch(
    optional,
    /rounded-pill px-3 py-2[\s\S]{0,80}ai\?\.enabled \? "On" : "Off"/
  );
});

test("voice transcription uses a radio list with explicit selected state", () => {
  assert.match(optional, /role="radiogroup"/);
  assert.match(optional, /role="radio"/);
  assert.match(optional, /aria-checked=\{selected\}/);
  assert.match(optional, /About 150 MB/);
  assert.match(optional, /About 500 MB/);
  assert.match(optional, /Installed on this device/);
  assert.match(optional, /rounded-full border/);
  assert.doesNotMatch(optional, /border-accent bg-accent\/5/);
});

test("settings platform cards separate connection status, last scan, and primary Scan", () => {
  assert.match(settings, /data-testid="platform-connection-status"/);
  assert.match(settings, /data-testid="platform-last-scan"/);
  assert.match(settings, /Last scanned \$\{formatRelative/);
  assert.match(settings, /primaryLabel=\{[^}]*Scan now/);
  assert.match(settings, /Not scanned yet/);
  assert.doesNotMatch(settings, /Scan ready/);
  assert.match(settings, /aria-label="More actions"/);
});

test("settings platform recovery actions sit behind More, not beside Scan", () => {
  const setupCard = settings.slice(
    settings.indexOf("function PlatformSetupCard"),
    settings.indexOf("function SetupGuideSection")
  );
  assert.match(setupCard, /secondaryItems\.length > 0/);
  assert.match(setupCard, /MoreVertical/);
  assert.match(settings, /label: "Open LinkedIn"/);
  assert.match(settings, /label: "Open Google Messages"/);
  assert.match(settings, /label: "Open Full Disk Access"/);
  assert.match(settings, /label: "Reconnect"/);
});

test("WhatsApp keeps one primary action and moves reset behind More with confirm", () => {
  assert.match(whatsapp, /Scan now/);
  assert.match(whatsapp, /aria-label="More actions"/);
  assert.match(whatsapp, /Reset WhatsApp/);
  assert.match(whatsapp, /window\.confirm\(/);
  assert.match(whatsapp, /lastScanAt/);
  assert.doesNotMatch(
    whatsapp,
    /Scan now[\s\S]{0,200}Reset WhatsApp[\s\S]{0,80}className="inline-flex/
  );
  assert.doesNotMatch(whatsapp, /Scan ready/);
});

test("platforms page uses Scan as primary when connected and recovery in More", () => {
  assert.match(platforms, /resolvePlatformPrimaryAction\(row\)/);
  assert.match(platforms, /platformScanEligible\(row\)/);
  assert.match(platforms, /primaryAction === "scan"/);
  assert.match(platforms, /"Scan now"/);
  assert.match(platforms, /"Reconnect"/);
  assert.match(platforms, /"Connect"/);
  assert.match(platforms, /aria-label="More actions"/);
  assert.match(platforms, /label: "Reset session…"/);
  assert.match(platforms, /window\.confirm\(/);
  assert.match(platforms, /data-testid="platform-connection-status"/);
  assert.match(platforms, /data-testid="platform-last-scan"/);
  assert.match(platforms, /Last scanned \$\{formatRelative/);
  assert.match(platforms, /label: "Open browser"/);
  assert.match(platforms, /label: "Reconnect"/);
  assert.match(platforms, /label: "Run selector tests"/);
  const moreStart = platforms.indexOf("const moreItems");
  assert.ok(moreStart > 0);
  const moreBlock = platforms.slice(moreStart, moreStart + 1800);
  assert.match(moreBlock, /primaryAction === "scan"/);
  assert.match(moreBlock, /Open browser/);
  assert.match(moreBlock, /Reconnect/);
  assert.match(moreBlock, /Run selector tests/);
});

test("platforms and settings classify recovery from error state, not status alone", () => {
  assert.match(platformSetup, /export function resolvePlatformPrimaryAction/);
  assert.match(platformSetup, /export function isPlatformAuthOrSessionError/);
  assert.match(platformSetup, /export function platformScanEligible/);
  assert.match(platforms, /from "@\/lib\/platform-setup"/);
  assert.match(settings, /from "@\/lib\/platform-setup"/);
  assert.match(settings, /resolvePlatformPrimaryAction\(googleMessagesRow\)/);
  assert.match(settings, /resolvePlatformPrimaryAction\(linkedinRow\)/);
  assert.doesNotMatch(
    platforms,
    /const scanEligible\s*=\s*[\s\S]{0,80}connected[\s\S]{0,40}DEGRADED[\s\S]{0,40}ERROR/
  );
  assert.doesNotMatch(
    settings,
    /function platformScanEligible\(status: PlatformCard\["status"\]\)/
  );
});
