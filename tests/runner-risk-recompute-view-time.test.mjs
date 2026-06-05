import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Risk (amber/red/green) is purely time-dependent, so it's recomputed live at
// every read surface instead of being read from the level frozen at the last
// scan/send. These source-invariants stop the staleness bug from creeping back
// at the two layers: the shaper (inbox / today / archived / people) and the
// /data/thread risk pill. The behavioural recompute is covered in
// runner-inbox-row-shaping.test.mjs.

const shapingSrc = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/services/thread-row-shaping.ts", import.meta.url)),
  "utf8"
);
const indexSrc = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/index.ts", import.meta.url)),
  "utf8"
);

test("the inbox shaper recomputes risk via calculateRisk, not the frozen source.riskLevel", () => {
  assert.match(shapingSrc, /const risk = calculateRisk\(\{/);
  assert.match(shapingSrc, /riskLevel: risk\.level/);
  assert.match(shapingSrc, /riskReason: risk\.riskReason/);
  // The frozen value must no longer be surfaced as the displayed level.
  assert.equal(shapingSrc.includes("riskLevel: source.riskLevel"), false);
});

test("/data/thread recomputes the risk pill via calculateRisk, not thread.riskLevel", () => {
  assert.match(indexSrc, /const liveThreadRisk = calculateRisk\(\{/);
  assert.match(indexSrc, /riskLevel: liveThreadRisk\.level/);
  assert.match(indexSrc, /riskReason: liveThreadRisk\.riskReason/);
  assert.equal(indexSrc.includes("riskLevel: thread.riskLevel"), false);
});
