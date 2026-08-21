import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Activity distinguishes loading, failure, and a genuine empty log", () => {
  const source = read("apps/dashboard/app/logs/page.tsx");
  assert.match(source, /useState<AuditLogRow\[\] \| null>\(null\)/);
  assert.match(source, /logs === null/);
  assert.match(source, /logs\.length === 0/);
  assert.match(source, /Failed to load activity/);
  assert.match(source, />\s*Try again\s*</);
});

test("Demo keeps sample mode available while reporting live-data failure", () => {
  const source = read("apps/dashboard/app/demo/page.tsx");
  assert.match(source, /Live conversations could not be loaded/);
  assert.match(source, /Sample conversations are still available/);
  assert.match(source, /inboxRows=\{rows \?\? \[\]\}/);
  assert.match(source, />\s*Try again\s*</);
});
