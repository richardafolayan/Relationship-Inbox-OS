import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunnerConfig } from "../apps/runner/dist/config.js";

test("runner binds to loopback by default", () => {
  const cfg = resolveRunnerConfig({});
  assert.equal(cfg.bindHost, "127.0.0.1");
});

test("RUNNER_HOST can intentionally override the bind host", () => {
  const cfg = resolveRunnerConfig({ RUNNER_HOST: "localhost" });
  assert.equal(cfg.bindHost, "localhost");
});

test("blank RUNNER_HOST falls back to loopback", () => {
  const cfg = resolveRunnerConfig({ RUNNER_HOST: "   " });
  assert.equal(cfg.bindHost, "127.0.0.1");
});
