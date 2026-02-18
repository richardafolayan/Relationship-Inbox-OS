import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectorCountEvaluateSource,
  evaluateSelectorCounts
} from "../apps/runner/dist/services/selector-tests.js";

test("selector evaluate callback source stays browser-safe and free of transpiler helper leakage", () => {
  const source = buildSelectorCountEvaluateSource();
  assert.equal(source.includes("__name"), false);
  assert.equal(source.includes("document.querySelectorAll"), true);
  assert.equal(source.includes("require("), false);
});

test("evaluateSelectorCounts executes with pure callback argument-only contract", async () => {
  let capturedSource = "";
  const fakePage = {
    evaluate: async (fn, selectors) => {
      capturedSource = String(fn);
      return selectors.map((selector) => (selector === ".thread-item" ? 3 : 0));
    }
  };

  const counts = await evaluateSelectorCounts(fakePage, [".thread-item", ".missing"]);
  assert.deepEqual(counts, [3, 0]);
  assert.equal(capturedSource.includes("__name"), false);
  assert.equal(capturedSource.includes("document.querySelectorAll"), true);
});
