import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "top-status.tsx"),
  "utf8"
);

test("top-status routes degraded platform status to platform settings", () => {
  assert.match(
    SRC,
    /\) : hasDegraded \? \(\s*<Link\s+href="\/settings#platforms"/,
    "degraded platforms should use the stripped v1 settings link, not a reconnect modal"
  );
});

test("top-status has no stale reconnect-modal state", () => {
  assert.doesNotMatch(SRC, /reconnectOpen|setReconnectOpen|shouldAutoCloseReconnect/);
});
