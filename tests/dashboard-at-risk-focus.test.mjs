import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/dashboard/app/at-risk/page.tsx", import.meta.url),
  "utf8"
);

test("legacy At Risk links land on the current Today workflow", () => {
  assert.match(source, /redirect\("\/today"\)/);
  assert.doesNotMatch(source, /archive|mark-done|apiPost|runAction/);
});
