import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppEnv, readEnvFile } from "../scripts/lib/env-file.mjs";

test("readEnvFile parses root .env syntax used by student launchers", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-env-file-"));
  const file = join(dir, ".env");
  writeFileSync(
    file,
    [
      "# ignored",
      "RUNNER_PORT=4501",
      "DASHBOARD_PORT = 3200",
      "QUOTED='hello world'",
      "DOUBLE_QUOTED=\"yes\"",
      "BROKEN_LINE"
    ].join("\n")
  );
  try {
    assert.deepEqual(readEnvFile(file), {
      RUNNER_PORT: "4501",
      DASHBOARD_PORT: "3200",
      QUOTED: "hello world",
      DOUBLE_QUOTED: "yes"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAppEnv fills missing launcher env without overriding explicit values", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-load-env-"));
  writeFileSync(join(dir, ".env"), "RUNNER_PORT=4501\nDASHBOARD_PORT=3200\n");
  const env = { RUNNER_PORT: "4999" };
  try {
    loadAppEnv(dir, env);
    assert.deepEqual(env, { RUNNER_PORT: "4999", DASHBOARD_PORT: "3200" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
