import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveSelectedScanPlatforms } from "../apps/runner/dist/services/scan-queue.js";

const adapters = {
  LINKEDIN: {},
  INSTAGRAM: {},
  WHATSAPP: {}
};

const source = await readFile(new URL("../apps/runner/src/index.ts", import.meta.url), "utf8");

function route(path, nextPath) {
  const start = source.indexOf(`app.post("${path}"`);
  const end = source.indexOf(`app.post("${nextPath}"`, start + 1);
  assert.notEqual(start, -1, `${path} route must exist`);
  assert.notEqual(end, -1, `${nextPath} route boundary must exist`);
  return source.slice(start, end);
}

test("scheduled and all-platform scans include only persisted selected platforms", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      enabledPlatforms: ["LINKEDIN"],
      adapters,
      isPlatformScannable: () => true
    }),
    ["LINKEDIN"]
  );
});

test("a queued event scan becomes a no-op after its platform is deselected", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      requestedPlatform: "WHATSAPP",
      enabledPlatforms: ["LINKEDIN"],
      adapters,
      isPlatformScannable: () => true
    }),
    []
  );
});

test("selected platforms still respect capability and platform scannability", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "WHATSAPP"],
      adapters,
      isPlatformScannable: (platform) => platform !== "WHATSAPP"
    }),
    ["LINKEDIN", "INSTAGRAM"]
  );
});

test("direct ingestion routes hold the selected-platform fence while persisting", () => {
  const imessageImport = route(
    "/control/imessage/import-history",
    "/control/thread/:threadId/send"
  );
  assert.match(
    imessageImport,
    /platformSelectionCoordinator\.withSelectedPlatform\("IMESSAGE"/
  );
  assert.ok(
    imessageImport.indexOf("syncThreadForIngest") >
      imessageImport.indexOf('withSelectedPlatform("IMESSAGE"')
  );

  const threadRescan = route(
    "/control/thread/:threadId/rescan",
    "/control/thread/:threadId/format-dictation-messages"
  );
  assert.match(
    threadRescan,
    /platformSelectionCoordinator\.withSelectedPlatform\(target\.platform/
  );
  assert.ok(
    threadRescan.indexOf("syncThreadForIngest") >
      threadRescan.indexOf("withSelectedPlatform(target.platform")
  );
});
