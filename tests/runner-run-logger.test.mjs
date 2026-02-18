import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRunLogger,
  executeTracedOperation
} from "../apps/runner/dist/services/run-logger.js";

function withTraceEnv(overrides = {}) {
  const previous = {
    RUN_TRACE: process.env.RUN_TRACE,
    RUN_TRACE_DIR: process.env.RUN_TRACE_DIR,
    RUN_TRACE_PII: process.env.RUN_TRACE_PII
  };
  process.env.RUN_TRACE = overrides.RUN_TRACE ?? "1";
  process.env.RUN_TRACE_DIR = overrides.RUN_TRACE_DIR;
  process.env.RUN_TRACE_PII = overrides.RUN_TRACE_PII ?? "0";
  return () => {
    process.env.RUN_TRACE = previous.RUN_TRACE;
    process.env.RUN_TRACE_DIR = previous.RUN_TRACE_DIR;
    process.env.RUN_TRACE_PII = previous.RUN_TRACE_PII;
  };
}

function readLines(input) {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("run trace creates NDJSON events and CSV actions when RUN_TRACE=1", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "runner-run-trace-"));
  const restoreEnv = withTraceEnv({
    RUN_TRACE: "1",
    RUN_TRACE_DIR: outDir,
    RUN_TRACE_PII: "0"
  });

  try {
    const logger = createRunLogger({
      requestId: "req-trace-create",
      platform: "LINKEDIN",
      runType: "scan",
      outDirBase: outDir
    });

    logger.logEvent({
      level: "info",
      component: "test",
      stage: "collect_threads",
      action: "collect_start",
      details: { sample: true }
    });
    logger.logAction({
      stage: "collect_threads",
      action: "scroll_container",
      selector: ".msg-conversations-container",
      url: "https://www.linkedin.com/messaging/",
      result: "ok",
      elapsedMs: 41,
      counts: { threadsCollected: 8 },
      note: "first pass"
    });
    logger.logAction({
      stage: "collect_threads",
      action: "scroll_container",
      selector: ".msg-conversations-container",
      url: "https://www.linkedin.com/messaging/",
      result: "ok",
      elapsedMs: 39,
      counts: { threadsCollected: 14 },
      note: "second pass"
    });

    const summary = logger.flush({
      success: true,
      stopReason: "end_of_list_no_progress"
    });

    assert.equal(Boolean(summary.eventsPath), true);
    assert.equal(Boolean(summary.actionsPath), true);

    const eventsRaw = await readFile(summary.eventsPath, "utf8");
    const actionsRaw = await readFile(summary.actionsPath, "utf8");
    const eventLines = readLines(eventsRaw);
    const actionLines = readLines(actionsRaw);

    assert.equal(eventLines.length >= 2, true);
    assert.equal(actionLines.length >= 3, true);
  } finally {
    restoreEnv();
  }
});

test("traced operations log an error event before rethrowing", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "runner-traced-operation-"));
  const restoreEnv = withTraceEnv({
    RUN_TRACE: "1",
    RUN_TRACE_DIR: outDir,
    RUN_TRACE_PII: "0"
  });

  try {
    const logger = createRunLogger({
      requestId: "req-trace-error",
      platform: "LINKEDIN",
      runType: "scan",
      outDirBase: outDir
    });

    await assert.rejects(
      executeTracedOperation({
        logger,
        component: "test",
        stage: "collect_threads",
        action: "traced_failure_action",
        selector: ".missing-selector",
        run: async () => {
          throw new Error("synthetic traced failure");
        }
      }),
      /synthetic traced failure/i
    );

    const summary = logger.flush({
      success: false,
      stopReason: "test_failure"
    });
    const eventsRaw = await readFile(summary.eventsPath, "utf8");
    const events = readLines(eventsRaw).map((line) => JSON.parse(line));
    const startIndex = events.findIndex((event) => event.action === "traced_failure_action_start");
    const errorIndex = events.findIndex(
      (event) => event.action === "traced_failure_action" && event.level === "error"
    );

    assert.equal(startIndex >= 0, true);
    assert.equal(errorIndex >= 0, true);
    assert.equal(errorIndex > startIndex, true);
  } finally {
    restoreEnv();
  }
});

test("run trace redacts long message text when RUN_TRACE_PII=0", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "runner-trace-redaction-"));
  const restoreEnv = withTraceEnv({
    RUN_TRACE: "1",
    RUN_TRACE_DIR: outDir,
    RUN_TRACE_PII: "0"
  });

  try {
    const logger = createRunLogger({
      requestId: "req-trace-redaction",
      platform: "LINKEDIN",
      runType: "scan",
      outDirBase: outDir
    });

    const sensitiveBody = `Message body: ${"x".repeat(240)}`;
    logger.logEvent({
      level: "info",
      component: "test",
      stage: "parse",
      action: "message_preview",
      details: {
        messageText: sensitiveBody,
        preview: sensitiveBody
      }
    });
    const summary = logger.flush({
      success: true
    });

    const eventsRaw = await readFile(summary.eventsPath, "utf8");
    assert.equal(eventsRaw.includes(sensitiveBody), false);
    assert.equal(eventsRaw.includes("[redacted]"), true);
  } finally {
    restoreEnv();
  }
});
