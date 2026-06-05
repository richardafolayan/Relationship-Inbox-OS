import test from "node:test";
import assert from "node:assert/strict";

// route.ts imports `next/server` only as a type, so the tsx loader resolves
// this module without Next at runtime (same pattern as the other
// dashboard-*.test.mjs that import a .ts lib directly). Importing it does not
// execute the GET handler — resolveRunnerBase is a pure env reader.
const { resolveRunnerBase } = await import(
  "../apps/dashboard/lib/runner-base.ts"
);

// Regression for #M6: the SSE proxy used to read RUNNER_ORIGIN only, while
// next.config.mjs derives the /runner and /artifacts rewrites from
// RUNNER_PORT. On a non-default port the proxy pointed at :4001 and live
// updates silently broke. resolveRunnerBase must mirror next.config.mjs:
// RUNNER_ORIGIN ?? `http://localhost:${RUNNER_PORT ?? "4001"}`.

const ORIGINAL = {
  RUNNER_ORIGIN: process.env.RUNNER_ORIGIN,
  RUNNER_PORT: process.env.RUNNER_PORT
};

function setEnv({ origin, port }) {
  if (origin === undefined) {
    delete process.env.RUNNER_ORIGIN;
  } else {
    process.env.RUNNER_ORIGIN = origin;
  }
  if (port === undefined) {
    delete process.env.RUNNER_PORT;
  } else {
    process.env.RUNNER_PORT = port;
  }
}

function restoreEnv() {
  setEnv({ origin: ORIGINAL.RUNNER_ORIGIN, port: ORIGINAL.RUNNER_PORT });
}

test("defaults to http://localhost:4001 when nothing is set", () => {
  setEnv({ origin: undefined, port: undefined });
  try {
    assert.equal(resolveRunnerBase(), "http://localhost:4001");
  } finally {
    restoreEnv();
  }
});

test("honours RUNNER_PORT for a non-default runner port (the regression)", () => {
  setEnv({ origin: undefined, port: "4002" });
  try {
    assert.equal(resolveRunnerBase(), "http://localhost:4002");
  } finally {
    restoreEnv();
  }
});

test("RUNNER_ORIGIN overrides RUNNER_PORT when both are set", () => {
  setEnv({ origin: "http://runner.internal:9000", port: "4002" });
  try {
    assert.equal(resolveRunnerBase(), "http://runner.internal:9000");
  } finally {
    restoreEnv();
  }
});

test("RUNNER_ORIGIN alone still works (back-compat)", () => {
  setEnv({ origin: "http://127.0.0.1:5555", port: undefined });
  try {
    assert.equal(resolveRunnerBase(), "http://127.0.0.1:5555");
  } finally {
    restoreEnv();
  }
});
