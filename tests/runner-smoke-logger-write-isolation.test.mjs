import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkedInSmokeLogger } from "../apps/runner/dist/services/linkedin-smoke-logger.js";

// Regression for P1-L10: emit() chains writes via
//   writeQueue = writeQueue.then(() => appendFile(...))
// Without a .catch, the first failed append (disk full, file removed,
// permission change mid-run) leaves writeQueue a rejected promise. Every
// subsequent emit() carries that rejection forward and then `await writeQueue`,
// so each later logLine/logStep rejects. Because the smoke endpoint awaits
// these (apps/runner/src/index.ts logLine/logLogDir calls), one transient
// write failure aborts the remaining logging/steps of the smoke run instead of
// degrading to best-effort. The fix isolates each write with .catch(() => {}).
//
// To force a deterministic append failure we replace the pretty.log file with a
// directory after construction, so every subsequent appendFile throws EISDIR.

async function makeBrokenLogger() {
  const base = await mkdtemp(join(tmpdir(), "smoke-logger-"));
  const logDir = join(base, "logdir");
  const logger = await createLinkedInSmokeLogger({ requestId: "test-req", logDir });
  // Replace the log file with a directory so future appendFile calls reject.
  await rm(logger.prettyLogPath, { force: true });
  await mkdir(logger.prettyLogPath);
  return { base, logger };
}

test("a single failed append does not poison subsequent smoke-log writes", async () => {
  const { base, logger } = await makeBrokenLogger();
  try {
    // First write fails internally (EISDIR) but must resolve, not reject.
    await assert.doesNotReject(() => logger.logLine("first line"));
    // The poison would surface here: a second write must also resolve.
    await assert.doesNotReject(() => logger.logLine("second line"));
    // logStep and logLogDir flow through the same emit() chain.
    await assert.doesNotReject(() =>
      logger.logStep({ step: 1, totalSteps: 2, stepName: "probe", message: "go" })
    );
    await assert.doesNotReject(() => logger.logLogDir());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("happy-path writes still land on disk after the fix", async () => {
  const base = await mkdtemp(join(tmpdir(), "smoke-logger-ok-"));
  const logDir = join(base, "logdir");
  try {
    const logger = await createLinkedInSmokeLogger({ requestId: "ok-req", logDir });
    await logger.logLine("alpha");
    await logger.logLine("beta");
    const contents = await readFile(logger.prettyLogPath, "utf8");
    assert.ok(contents.includes("alpha"));
    assert.ok(contents.includes("beta"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
