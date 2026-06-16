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
  assert.doesNotMatch(SOURCE, /npm run|node scripts|Terminal|Ctrl \+ C|Update and relaunch|Update staged/);
});
