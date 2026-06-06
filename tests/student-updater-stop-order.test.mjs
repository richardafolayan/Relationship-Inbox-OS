import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression for #554: applyUpdate copied the preserved data/ dir (the live
// SQLite DB) BEFORE stopping the running app, so a concurrent write could yield
// a torn DB copy the pilot then boots on. stopAppProcesses must run BEFORE the
// PRESERVE cpSync loop.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "scripts", "update-student.mjs"), "utf8");

test("stopAppProcesses runs before the PRESERVE copy loop", () => {
  const stopIdx = SRC.indexOf("stopAppProcesses(APP_DIR);");
  const copyIdx = SRC.indexOf("cpSync(from, join(appNew, item)");
  assert.ok(stopIdx > 0, "stopAppProcesses call present");
  assert.ok(copyIdx > 0, "PRESERVE cpSync present");
  assert.ok(stopIdx < copyIdx, "the app must be stopped BEFORE the live DB is copied");
});
