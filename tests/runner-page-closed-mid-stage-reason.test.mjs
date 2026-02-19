import test from "node:test";
import assert from "node:assert/strict";
import { resolveLinkedInScanFailureReason } from "../apps/runner/dist/platforms/linkedin-adapter.js";

test("LinkedIn failure classification maps target-closed errors to page_closed_mid_stage", () => {
  const reason = resolveLinkedInScanFailureReason({
    message: "page.waitForSelector: Target page, context or browser has been closed"
  });

  assert.equal(reason, "page_closed_mid_stage");
});
