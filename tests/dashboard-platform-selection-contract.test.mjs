import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  assert.match(route, /enabled: settings\.enabledPlatforms\.includes\(platform\)/);
});

test("unselected platform cards route to setup and hide external controls", () => {
  assert.match(platformsPage, /row\.enabled === false[\s\S]*?"Add in setup"/);
  assert.match(platformsPage, /startSetupWizard\(\)/);
  assert.match(platformsPage, /moreItems: MenuItem\[\] = row\.enabled === false \? \[\]/);
  assert.match(platformsPage, /"Choose this source in setup"/);
});

test("Settings keeps Add in setup available while suppressing source actions", () => {
  assert.match(settingsPage, /effectivePrimaryLabel = enabled \? primaryLabel : "Add in setup"/);
  assert.match(settingsPage, /effectivePrimaryAction = enabled \? onPrimary : startSetupWizard/);
  assert.match(settingsPage, /secondaryItems = enabled \? \(moreItems \?\? \[\]\) : \[\]/);
  assert.doesNotMatch(
    settingsPage,
    /disabled=\{busy \|\| !enabled \|\| !supported \|\| remoteDisabled\}/
  );
});
