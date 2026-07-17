import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";

function createMockPage() {
  const bindings = new Map();
  let evaluateCount = 0;
  const page = {
    isClosed: () => false,
    url: () => "https://www.linkedin.com/messaging/",
    on() {},
    async exposeFunction(name, fn) {
      if (bindings.has(name)) {
        throw new Error(`Function "${name}" has been already registered`);
      }
      bindings.set(name, fn);
    },
    async evaluate() {
      evaluateCount += 1;
    },
    context() {
      return {
        async addInitScript() {}
      };
    },
    async addScriptTag() {},
    mainFrame() {
      return {};
    },
    getBindings() {
      return bindings;
    },
    getEvaluateCount() {
      return evaluateCount;
    }
  };
  return page;
}

function buildAdapter(page) {
  return new LinkedInAdapter({
    screenshotDir: join(tmpdir(), "linkedin-watcher-screens"),
    domDumpDir: join(tmpdir(), "linkedin-watcher-dom"),
    resolveSelectors: async () => ({
      inbox_url: "https://www.linkedin.com/messaging/"
    }),
    sessionManager: {
      getManagedPage: async () => page
    },
    personKey: "default",
    scanMaxThreads: 30,
    scanStableIterations: 3,
    scanScrollWaitMs: 80,
    messageBackfillAttempts: 1
  });
}

async function waitForArmed(logs, { fromIndex = 0, timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recent = logs.slice(fromIndex);
    if (recent.some((line) => line.includes("[linkedin-watcher] armed"))) {
      return;
    }
    if (recent.some((line) => line.includes("failed to arm"))) {
      throw new Error(`watcher failed to arm: ${recent.join(" | ")}`);
    }
    await delay(20);
  }
  throw new Error(
    `watcher did not arm within ${timeoutMs}ms: ${logs.slice(fromIndex).join(" | ")}`
  );
}

test("stop then start on the same page reuses binding and swaps callback (#892)", async () => {
  const page = createMockPage();
  const adapter = buildAdapter(page);
  const firstChanges = [];
  const secondChanges = [];
  const logs = [];

  const first = adapter.startInboxRealtimeWatcher({
    debounceMs: 100,
    onChange: (change) => firstChanges.push(change),
    log: (line) => logs.push(line)
  });
  await waitForArmed(logs);

  assert.equal(page.getBindings().size, 1, "binding registered once on first start");
  const evaluateAfterFirstArm = page.getEvaluateCount();
  assert.ok(evaluateAfterFirstArm >= 1, "DOM observer installed on first start");

  const bound = page.getBindings().get("__relationshipInboxLinkedInChanged");
  assert.equal(typeof bound, "function");
  bound({ reason: "mutation", sourceChangedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(firstChanges.length, 1);
  assert.equal(firstChanges[0].reason, "mutation");

  first.stop();
  const evaluateAfterStop = page.getEvaluateCount();

  const logsAfterStop = logs.length;
  const second = adapter.startInboxRealtimeWatcher({
    debounceMs: 100,
    onChange: (change) => secondChanges.push(change),
    log: (line) => logs.push(line)
  });
  await waitForArmed(logs, { fromIndex: logsAfterStop });

  assert.equal(page.getBindings().size, 1, "same-page restart must not re-expose the binding");
  assert.ok(
    page.getEvaluateCount() > evaluateAfterStop,
    "DOM observer reinstalled on restart"
  );
  assert.ok(
    !logs.some((line) => line.includes("failed to arm")),
    `restart must not fail: ${logs.join(" | ")}`
  );

  bound({ reason: "local_fingerprint", sourceChangedAt: "2026-01-01T00:01:00.000Z" });
  assert.equal(firstChanges.length, 1, "stopped watcher callback must not receive events");
  assert.equal(secondChanges.length, 1, "active restart callback receives binding events");
  assert.equal(secondChanges[0].reason, "local_fingerprint");

  second.stop();
});

test("new page instance re-exposes the binding after the previous page is gone (#892)", async () => {
  const firstPage = createMockPage();
  let activePage = firstPage;
  const adapter = new LinkedInAdapter({
    screenshotDir: join(tmpdir(), "linkedin-watcher-screens"),
    domDumpDir: join(tmpdir(), "linkedin-watcher-dom"),
    resolveSelectors: async () => ({
      inbox_url: "https://www.linkedin.com/messaging/"
    }),
    sessionManager: {
      getManagedPage: async () => activePage
    },
    personKey: "default",
    scanMaxThreads: 30,
    scanStableIterations: 3,
    scanScrollWaitMs: 80,
    messageBackfillAttempts: 1
  });

  const logs = [];
  const first = adapter.startInboxRealtimeWatcher({
    debounceMs: 100,
    onChange: () => {},
    log: (line) => logs.push(line)
  });
  await waitForArmed(logs);
  assert.equal(firstPage.getBindings().size, 1);
  first.stop();

  const secondPage = createMockPage();
  activePage = secondPage;
  const logsAfter = logs.length;
  const second = adapter.startInboxRealtimeWatcher({
    debounceMs: 100,
    onChange: () => {},
    log: (line) => logs.push(line)
  });
  await waitForArmed(logs, { fromIndex: logsAfter });

  assert.equal(secondPage.getBindings().size, 1, "fresh page gets a new exposeFunction");
  assert.equal(firstPage.getBindings().size, 1, "prior page binding registration is unchanged");
  second.stop();
});
