import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(
  join(ROOT, "apps/dashboard/components/settings/AppUpdates.tsx"),
  "utf8"
);

test("app update card keeps pilot copy away from terminal commands", () => {
  assert.match(SOURCE, /Update app/);
  assert.match(SOURCE, /Updating app/);
  assert.match(SOURCE, /Start runner/);
  assert.match(SOURCE, /Install updates automatically/);
  assert.match(SOURCE, /checks shortly after opening and once an hour/);
  assert.match(SOURCE, /What’s new in v/);
  assert.match(SOURCE, /Coming in v/);
  assert.match(SOURCE, /Array\.isArray\(res\.currentReleaseNotes\)/);
  assert.match(SOURCE, /local runner/);
  assert.doesNotMatch(SOURCE, /npm run|node scripts|Terminal|Ctrl \+ C|Update and relaunch|Update staged/);
  assert.doesNotMatch(SOURCE, /Is the app running/);
});
