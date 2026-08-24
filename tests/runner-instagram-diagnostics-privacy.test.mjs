import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunLogger } from "../apps/runner/dist/services/run-logger.js";
import {
  platformDiagnosticArtifactsAllowed,
  sanitizePlatformAuditInput
} from "../apps/runner/dist/services/platform-diagnostics.js";

test("Instagram diagnostics cannot persist private values or content-bearing artifacts", async () => {
  const privateSentinel = "PRIVATE_ANN_https://instagram.example/thread/raw-id_message-body";
  const outDir = await mkdtemp(join(tmpdir(), "instagram-diagnostics-"));
  const screenshotPath = join(outDir, "source.png");
  const domPath = join(outDir, "source.html");
  await writeFile(screenshotPath, privateSentinel, "utf8");
  await writeFile(domPath, privateSentinel, "utf8");

  const previousPii = process.env.RUN_TRACE_PII;
  process.env.RUN_TRACE_PII = "1";
  try {
    const logger = createRunLogger({
      requestId: "instagram-private-boundary",
      platform: "INSTAGRAM",
      runType: "scan",
      outDirBase: outDir,
      forceEnabled: true,
      emitConsole: false
    });

    logger.logEvent({
      level: "info",
      component: "privacy-test",
      stage: "collect_threads",
      action: "candidate_seen",
      url: privateSentinel,
      pageId: privateSentinel,
      details: {
        threadDisplayName: privateSentinel,
        threadId: privateSentinel,
        preview: privateSentinel,
        nested: { raw: privateSentinel },
        count: 3,
        complete: true
      }
    });
    logger.logAction({
      stage: "collect_threads",
      action: "open_candidate",
      selector: privateSentinel,
      url: privateSentinel,
      result: "ok",
      counts: { candidates: 1, name: privateSentinel },
      note: privateSentinel
    });
    logger.logError({
      component: "privacy-test",
      stage: "collect_threads",
      error: new Error(privateSentinel),
      details: { rawError: privateSentinel },
      url: privateSentinel,
      pageId: privateSentinel
    });
    logger.mergeCounters({ accepted: 2, recipient: privateSentinel });
    logger.setStopReason(privateSentinel);

    assert.deepEqual(
      logger.copyFailureArtifacts({ screenshotPath, domDumpPath: domPath }),
      {}
    );
    logger.attachArtifact({
      playwrightTracePath: privateSentinel,
      failureScreenshotPath: screenshotPath,
      failureDomDumpPath: domPath
    });

    const summary = logger.flush({
      success: false,
      error: new Error(privateSentinel)
    });
    const fileNames = await readdir(summary.runDir);
    assert.equal(fileNames.includes("failure.png"), false);
    assert.equal(fileNames.includes("dom.html"), false);
    assert.equal(fileNames.includes("playwright-trace.zip"), false);
    assert.equal(summary.failureScreenshotPath, undefined);
    assert.equal(summary.failureDomDumpPath, undefined);
    assert.equal(summary.playwrightTracePath, undefined);
    assert.equal(summary.counters.accepted, 2);
    assert.equal(summary.counters.recipient, "[redacted]");

    const diagnosticText = (
      await Promise.all(
        fileNames
          .filter((name) => /\.(?:ndjson|csv|json|log)$/.test(name))
          .map((name) => readFile(join(summary.runDir, name), "utf8"))
      )
    ).join("\n");
    assert.equal(diagnosticText.includes(privateSentinel), false);
    assert.equal(JSON.stringify(summary).includes(privateSentinel), false);
    assert.equal(diagnosticText.includes("[redacted]"), true);
  } finally {
    process.env.RUN_TRACE_PII = previousPii;
  }
});

test("Instagram audit records preserve structure but strip private values and artifact paths", () => {
  const privateSentinel = "PRIVATE_JOANNE_RAW_THREAD_ID";
  const input = {
    platform: "INSTAGRAM",
    stage: "Scan",
    action: "THREAD_SYNC_FAIL",
    status: "FAIL",
    details: {
      threadId: privateSentinel,
      displayName: privateSentinel,
      errorStack: privateSentinel,
      count: 4,
      retrying: false
    },
    screenshotFile: `${privateSentinel}.png`,
    domDumpFile: `${privateSentinel}.html`
  };

  const safe = sanitizePlatformAuditInput(input);

  assert.equal(safe.action, input.action);
  assert.equal(safe.status, input.status);
  assert.equal(safe.details.count, 4);
  assert.equal(safe.details.retrying, false);
  assert.equal(safe.details.threadId, "[redacted]");
  assert.equal(safe.screenshotFile, undefined);
  assert.equal(safe.domDumpFile, undefined);
  assert.equal(JSON.stringify(safe).includes(privateSentinel), false);
  assert.equal(platformDiagnosticArtifactsAllowed("INSTAGRAM"), false);
  assert.equal(platformDiagnosticArtifactsAllowed("LINKEDIN"), true);
});
