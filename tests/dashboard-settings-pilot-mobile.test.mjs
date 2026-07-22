import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Pilot content rides the shared Settings mobile subpage system from #936", () => {
  // Do not re-implement or re-assert a second nav; only confirm Pilot uses the shared one.
  const settings = read("apps/dashboard/app/settings/page.tsx");

  assert.match(settings, /mobileDetailOpen/);
  assert.match(settings, /function getRouteScroller\(\)/);
  assert.match(settings, /backToSettingsList/);
  assert.match(settings, /openMobileCategory/);
  assert.match(settings, /activeTab === "pilot"/);
  assert.match(settings, /data-testid="settings-pilot"/);
  // No parallel #912-only nav flag.
  assert.doesNotMatch(settings, /mobileSubpageOpen/);
  assert.doesNotMatch(settings, /listLayout/);
});

test("Pilot actions use full-width touch targets without pill wrap", () => {
  const settings = read("apps/dashboard/app/settings/page.tsx");
  const pilotSectionStart = settings.indexOf('data-testid="settings-pilot"');
  const pilotSection = settings.slice(pilotSectionStart, pilotSectionStart + 1800);
  const btnStart = settings.indexOf("function PilotActionButton");
  const btnEnd = settings.indexOf("function SettingsGroup", btnStart);
  const pilotButton = settings.slice(btnStart, btnEnd);

  assert.match(pilotSection, /data-testid="settings-pilot-actions"/);
  assert.match(pilotSection, /flex flex-col gap-2/);
  assert.match(pilotButton, /w-full min-h-\[48px\]/);
  assert.doesNotMatch(pilotButton, /rounded-pill/);
  assert.doesNotMatch(pilotSection, /flex-wrap/);
  assert.match(settings, /Share feedback/);
  assert.match(settings, /Report a bug/);
  assert.match(settings, /Show welcome card again/);
  assert.match(settings, /Replay walkthrough/);
  assert.match(settings, /startPilotTour\(\{ replay: true \}\)/);
});

test("Settings Pilot welcome is concise for mobile", () => {
  const welcome = read("apps/dashboard/components/common/pilot-welcome.tsx");
  const settings = read("apps/dashboard/app/settings/page.tsx");

  assert.match(settings, /<PilotWelcomeCard settings \/>/);
  assert.match(welcome, /settings\?: boolean/);
  assert.match(welcome, /if \(settings\)/);
  assert.match(welcome, /Welcome to \{APP_NAME\}/);
  assert.match(welcome, /Replies send when you choose/);
  assert.match(welcome, /Focus notes only send automatically/);
  const settingsBlock = welcome.slice(
    welcome.indexOf("if (settings)"),
    welcome.indexOf("if (compact)")
  );
  assert.doesNotMatch(settingsBlock, /Who is waiting/);
  assert.ok(settingsBlock.length < 900, "settings welcome should stay short");
});

test("Demo lives under Pilot with sample vs real copy and no sandbox jargon", () => {
  const card = read("apps/dashboard/components/full-demo/FullDemoSettingsCard.tsx");
  const start = read("apps/dashboard/components/full-demo/FullDemoStartScreen.tsx");
  const banner = read("apps/dashboard/components/full-demo/FullDemoBanner.tsx");
  const demoPage = read("apps/dashboard/app/demo/page.tsx");
  const settings = read("apps/dashboard/app/settings/page.tsx");

  assert.match(settings, /activeTab === "pilot"/);
  assert.match(settings, /<FullDemoSettingsCard \/>/);
  // Demo card is not under App anymore.
  const appStart = settings.indexOf('activeTab === "app"');
  const pilotStart = settings.indexOf('activeTab === "pilot"');
  assert.ok(appStart > 0 && pilotStart > appStart);
  const appBlock = settings.slice(appStart, pilotStart);
  assert.doesNotMatch(appBlock, /FullDemoSettingsCard/);
  assert.doesNotMatch(settings, /head="Demo"/);

  for (const src of [card, start, banner, demoPage]) {
    assert.doesNotMatch(src, /seeded showcase/i);
    assert.doesNotMatch(src, /Sandbox uses/i);
    assert.doesNotMatch(src, /Live mode is read-only against real threads you choose/i);
  }

  assert.match(card, /Try with sample conversations/);
  assert.match(card, /explore selected real conversations without sending/i);
  assert.match(card, /Nothing is sent automatically/);
  assert.match(card, /w-full/);
  assert.match(card, /Run demo/);

  assert.match(start, /Try with sample conversations/);
  assert.match(start, /Explore using selected real conversations without sending/);
  assert.match(start, /Nothing is sent automatically/);
  assert.match(start, /data-testid="full-demo-start-sample"/);
  assert.match(start, /data-testid="full-demo-start-real"/);
  assert.match(start, /Read-only\. Nothing is sent automatically/);

  assert.match(banner, /Sample demo running/);
  assert.match(banner, /Real conversations, read-only/);
  assert.match(banner, /Nothing is sent automatically/);

  assert.match(demoPage, /Nothing is sent automatically/);
});

test("demo script and pilot tour drop user-facing sandbox jargon", () => {
  const script = read("apps/dashboard/lib/full-demo-script.ts");
  const tour = read("apps/dashboard/lib/pilot-tour.ts");

  assert.match(script, /id: "settings"/);
  assert.match(script, /Sample mode uses practice conversations/);
  assert.match(script, /Nothing is sent automatically/);
  assert.doesNotMatch(script, /Sandbox uses seeded data/i);
  assert.doesNotMatch(script, /Live mode is read-only against your real threads/i);

  assert.match(tour, /key: "demo-loaded"/);
  assert.match(tour, /Sample conversations loaded/);
  assert.match(tour, /beat: "Samples ready"/);
  assert.doesNotMatch(tour, /stay inside sandbox data/i);
  assert.doesNotMatch(tour, /beat: "Sandbox ready"/);
});

test("Settings list scroll uses shared getRouteScroller not bare main.scrollTop", () => {
  const settings = read("apps/dashboard/app/settings/page.tsx");

  assert.match(settings, /listScrollYRef/);
  assert.match(settings, /function getRouteScroller\(\)/);
  assert.match(
    settings,
    /listScrollYRef\.current = getRouteScroller\(\)\?\.scrollTop/
  );
  assert.match(settings, /data-scroll-owner=["']canvas["']/);
  assert.match(settings, /data-scroll-owner=["']list["']/);
  assert.doesNotMatch(
    settings,
    /listScrollYRef\.current = document\.querySelector\(["']main["']\)\?\.scrollTop/
  );
  assert.doesNotMatch(settings, /window\.scrollTo\s*\(/);
  assert.doesNotMatch(settings, /window\.scrollY\b/);
});
