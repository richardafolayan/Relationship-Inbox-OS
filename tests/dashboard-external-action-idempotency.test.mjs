import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);

test("message mutations keep one client action id across an uncertain retry", () => {
  assert.match(source, /externalActionAttemptRef = useRef<Map<string, string>>/);
  for (const action of ["reaction", "poll-vote", "edit"]) {
    assert.match(source, new RegExp("attemptKey = `" + action + ":"));
  }
  assert.equal((source.match(/externalActionAttemptRef\.current\.get\(attemptKey\) \?\? uuid\(\)/g) ?? []).length, 3);
  assert.equal((source.match(/\{ clientActionId,/g) ?? []).length >= 3, true);
  assert.equal((source.match(/externalActionAttemptRef\.current\.delete\(attemptKey\)/g) ?? []).length, 3);
});
