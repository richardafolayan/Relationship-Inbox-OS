import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runnerSource = await readFile(
  new URL("../apps/runner/src/index.ts", import.meta.url),
  "utf8"
);
const adapterSource = await readFile(
  new URL("../apps/runner/src/platforms/instagram-adapter.ts", import.meta.url),
  "utf8"
);
const factorySource = await readFile(
  new URL("../apps/runner/src/services/platform-factory.ts", import.meta.url),
  "utf8"
);
const scanQueueSource = await readFile(
  new URL("../apps/runner/src/services/scan-queue.ts", import.meta.url),
  "utf8"
);
const resetCoordinatorSource = await readFile(
  new URL(
    "../apps/runner/src/services/platform-session-reset-coordinator.ts",
    import.meta.url
  ),
  "utf8"
);
const schemaSource = await readFile(
  new URL("../packages/core/prisma/schema.prisma", import.meta.url),
  "utf8"
);
const selectors = JSON.parse(
  await readFile(
    new URL("../packages/core/selectors/instagram.json", import.meta.url),
    "utf8"
  )
);

test("server setup validation and interactive connection include Instagram", () => {
  assert.match(
    runnerSource,
    /z\.enum\(\["IMESSAGE", "LINKEDIN", "INSTAGRAM", "WHATSAPP", "GOOGLE_MESSAGES"\]\)/
  );
  assert.match(
    runnerSource,
    /platformAdapter\.connectInteractively\?\.\(\) \?\? platformAdapter\.ensureConnected\(\)/
  );
  assert.match(
    runnerSource,
    /platform === "INSTAGRAM"\) return resolveConnectTimeoutMs\("personal", process\.env\)/
  );
  assert.match(factorySource, /preferInstalledChrome: true/);
  assert.match(factorySource, /connectTimeoutMs: resolveConnectTimeoutMs\("personal"\)/);
});

test("session reset uses the isolated-platform reset plan", () => {
  assert.match(
    resetCoordinatorSource,
    /planPlatformSessionReset\(\[\.\.\.deps\.platforms\], requestedPlatform\)/
  );
  assert.match(resetCoordinatorSource, /if \(plan\.resetInstagramSession\)/);
  assert.match(runnerSource, /resolvePlatformSession\("INSTAGRAM"\)/);
  assert.match(
    resetCoordinatorSource,
    /for \(const platform of plan\.statusPlatforms\)/
  );
  assert.match(
    runnerSource,
    /platformSessionResetCoordinator\.reset\(payload\.platform\)/
  );
});

test("Instagram selectors and adapter never use a first-row or Enter-key send fallback", () => {
  assert.equal(selectors.thread_item, "a[href^='/direct/t/']");
  assert.equal(selectors.thread_link, "a[href^='/direct/t/']");
  assert.doesNotMatch(adapterSource, /keyboard\.press\(["']Enter/);
  assert.doesNotMatch(adapterSource, /thread_item\)\.first\(\)/);
  assert.match(adapterSource, /verifiedBy: "bubble_detected"/);
});

test("Instagram failures do not invoke content-bearing diagnostics", () => {
  assert.doesNotMatch(adapterSource, /toStageFailure|captureDiagnostics|page\.screenshot|page\.content/);
  assert.match(adapterSource, /details: \{ reason \}/);
});

test("message identity reconciliation stays behind a platform-neutral scan capability", () => {
  assert.doesNotMatch(scanQueueSource, /instagram-message-key-upgrade/);
  assert.doesNotMatch(scanQueueSource, /planInstagramMessageKeyUpgrades/);
  assert.match(scanQueueSource, /messageIdentityReconcilers/);
  assert.match(
    runnerSource,
    /messageIdentityReconcilers:\s*\{[\s\S]*?INSTAGRAM:\s*createInstagramMessageIdentityReconciler\(prisma\)/
  );
});

test("platform recipient verification identity is persisted separately from Person display copy", () => {
  assert.match(schemaSource, /recipientVerificationLabel\s+String\?/);
  assert.match(runnerSource, /recipientVerificationLabel: thread\.recipientVerificationLabel \?\? undefined/);
  assert.match(
    scanQueueSource,
    /recipientVerificationLabel: candidate\.recipientVerificationLabel/
  );
});

test("identity quarantine remains visible and cannot publish a false persisted-message event", () => {
  assert.match(scanQueueSource, /if \(syncTiming && persistedMessages > 0\)/);
  assert.match(
    scanQueueSource,
    /resolvePlatformScanFreshness\(\{\s*quarantinedMessages: freshnessIdentityQuarantines,\s*threadFailures: threadFailures \+ collectionFailures,\s*candidateCapBroke,\s*collectionIncomplete/
  );
  assert.match(scanQueueSource, /markScanComplete: publishedFreshness\.advanceLastScanAt/);
  assert.match(
    scanQueueSource,
    /if \(freshnessComplete\) \{\s*retryController\.markSuccess\(platform\);\s*runError = undefined;/
  );
  assert.match(runnerSource, /freshnessComplete: result\.freshnessComplete/);
  assert.match(runnerSource, /status: result\.freshnessComplete \? "OK" : "FAIL"/);
  assert.match(
    runnerSource,
    /if \(!result\.freshnessComplete\) \{\s*res\.status\(409\)\.json\(/
  );
});
