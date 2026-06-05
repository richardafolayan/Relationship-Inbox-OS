import test from "node:test";
import assert from "node:assert/strict";
import { safeJsonParse } from "../apps/runner/dist/utils/json.js";

test("safeJsonParse: parses valid JSON", () => {
  assert.deepEqual(safeJsonParse('{"a":1,"b":[2,3]}', null), { a: 1, b: [2, 3] });
  assert.deepEqual(safeJsonParse("[1,2,3]", []), [1, 2, 3]);
  assert.equal(safeJsonParse('"hi"', null), "hi");
});

test("safeJsonParse: null/undefined/empty return the fallback", () => {
  assert.deepEqual(safeJsonParse(null, { ok: true }), { ok: true });
  assert.deepEqual(safeJsonParse(undefined, []), []);
  assert.equal(safeJsonParse("", "fallback"), "fallback");
});

test("safeJsonParse: malformed JSON returns the fallback (never throws)", () => {
  assert.deepEqual(safeJsonParse("{not json", { fellBack: true }), { fellBack: true });
  assert.deepEqual(safeJsonParse("[1,2,", []), []);
  assert.equal(safeJsonParse("undefined", null), null);
  assert.deepEqual(safeJsonParse("{'single':'quotes'}", {}), {});
});

test("safeJsonParse: fallback type is preserved for empty-store defaults", () => {
  // Mirrors the settings/thread call sites: a corrupt row degrades to the
  // sensible empty default rather than throwing out of the handler.
  assert.deepEqual(safeJsonParse("garbage", {}), {});
  assert.deepEqual(safeJsonParse("garbage", []), []);
});
