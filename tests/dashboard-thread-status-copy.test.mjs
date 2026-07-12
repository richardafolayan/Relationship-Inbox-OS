import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);
const statusCopy = source.slice(
  source.indexOf("const riskLabel ="),
  source.indexOf("// Suggestion source:")
);

test("thread status does not imply the operator replied to an inbound message", () => {
  assert.match(statusCopy, /overdue · received \$\{formatRelative\(lastInboundAt\)\}/);
  assert.match(statusCopy, /waiting · received \$\{formatRelative\(lastInboundAt\)\}/);
  assert.match(statusCopy, /fresh · last message \$\{formatRelative\(lastTimestamp\)\}/);
  assert.doesNotMatch(statusCopy, /last reply/);
});
