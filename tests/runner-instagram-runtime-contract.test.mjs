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

test("Instagram reset is isolated from the shared browser profile", () => {
  const instagramReset = runnerSource.indexOf('if (payload.platform === "INSTAGRAM")');
  const sharedReset = runnerSource.indexOf(
    "const summary = await sessionManager.resetPersonSession",
    instagramReset
  );
  assert.ok(instagramReset > -1);
  assert.ok(sharedReset > instagramReset);
  assert.match(
    runnerSource.slice(instagramReset, sharedReset),
    /resolvePlatformSession\("INSTAGRAM"\)/
  );
  assert.match(
    runnerSource.slice(instagramReset, sharedReset),
    /where: \{ name: "INSTAGRAM" \}/
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
