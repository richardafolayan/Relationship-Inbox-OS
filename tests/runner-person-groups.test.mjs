import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersonGroups } from "../apps/runner/dist/services/person-groups.js";

test("normalizePersonGroups trims, dedupes and limits groups", () => {
  const groups = normalizePersonGroups([
    "  Close friends  ",
    "Close   friends",
    "",
    "Society",
    1,
    "A very long group name that should be cut down to forty characters"
  ]);
  assert.deepEqual(groups, [
    "Close friends",
    "Society",
    "A very long group name that should be cu"
  ]);
});
