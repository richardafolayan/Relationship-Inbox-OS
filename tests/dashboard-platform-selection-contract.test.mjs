import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlatformSelectionControls } from "../apps/dashboard/lib/platform-selection-controls.ts";
import { isPlatformEnabled } from "../apps/runner/src/platform-availability.ts";

const runner = readFileSync(
  new URL("../apps/runner/src/index.ts", import.meta.url),
  "utf8"
);
const platformsPage = readFileSync(
  new URL("../apps/dashboard/app/platforms/page.tsx", import.meta.url),
  "utf8"
);
const settingsPage = readFileSync(
  new URL("../apps/dashboard/app/settings/page.tsx", import.meta.url),
  "utf8"
);

test("platform data reports persisted source selection", () => {
  const start = runner.indexOf('app.get("/data/platforms"');
  const end = runner.indexOf('app.get("/data/logs"', start);
  const route = runner.slice(start, end);
  assert.match(route, /settingsStore\.getSettings\(\)/);
  assert.match(route, /enabled: isPlatformEnabled\(settings\.enabledPlatforms, platform\)/);
  assert.equal(isPlatformEnabled(["LINKEDIN"], "INSTAGRAM"), false);
  assert.equal(isPlatformEnabled(["LINKEDIN"], "LINKEDIN"), true);
});

test("unselected platform controls execute setup without exposing external actions", () => {
  let setupCalls = 0;
  let externalCalls = 0;
  const externalAction = () => { externalCalls += 1; };
  const controls = resolvePlatformSelectionControls({
    enabled: false,
    primaryLabel: "Scan now",
    primaryAction: externalAction,
    setupAction: () => { setupCalls += 1; },
    secondaryActions: [externalAction]
  });

  assert.equal(controls.statusLabel, "Off");
  assert.equal(controls.primaryLabel, "Add in setup");
  assert.deepEqual(controls.secondaryActions, []);
  controls.primaryAction();
  assert.equal(setupCalls, 1);
  assert.equal(externalCalls, 0);
});

test("both platform surfaces consume the executable selection policy", () => {
  assert.match(platformsPage, /resolvePlatformSelectionControls\(\{/);
  assert.match(settingsPage, /resolvePlatformSelectionControls\(\{/);
  assert.match(platformsPage, /"Choose this source in setup"/);
  assert.doesNotMatch(
    settingsPage,
    /disabled=\{busy \|\| !enabled \|\| !supported \|\| remoteDisabled\}/
  );
});
