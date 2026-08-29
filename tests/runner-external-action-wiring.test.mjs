import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../apps/runner/src/index.ts", import.meta.url), "utf8");

function route(path, nextPath) {
  const start = source.indexOf(`app.post("${path}"`);
  const end = source.indexOf(`"${nextPath}"`, start + 1);
  assert.notEqual(start, -1, `${path} route must exist`);
  assert.notEqual(end, -1, `${nextPath} route boundary must exist`);
  return source.slice(start, end);
}

test("synchronous message mutations use the shared external-action fence", () => {
  const routes = [
    ["/control/thread/:threadId/send-poll", "/control/thread/:threadId/update-send"],
    ["/control/thread/:threadId/message/:messageId/react", "/control/thread/:threadId/message/:messageId/edit"],
    ["/control/thread/:threadId/message/:messageId/edit", "/control/thread/:threadId/message/:messageId/poll-vote"],
    ["/control/thread/:threadId/message/:messageId/poll-vote", "/control/thread/:threadId/message/:messageId/poll-votes"]
  ];

  for (const [path, nextPath] of routes) {
    const block = route(path, nextPath);
    assert.match(block, /threadExternalActionFence\.run\(threadId/);
    assert.doesNotMatch(block, /withPlatformControlLock\(/);
  }
});

test("message and thread rows are reloaded only after entering the fence", () => {
  const poll = route(
    "/control/thread/:threadId/send-poll",
    "/control/thread/:threadId/update-send"
  );
  assert.ok(
    poll.indexOf("prisma.thread.findUnique") > poll.indexOf("threadExternalActionFence.run")
  );

  for (const [path, nextPath] of [
    ["/control/thread/:threadId/message/:messageId/react", "/control/thread/:threadId/message/:messageId/edit"],
    ["/control/thread/:threadId/message/:messageId/edit", "/control/thread/:threadId/message/:messageId/poll-vote"],
    ["/control/thread/:threadId/message/:messageId/poll-vote", "/control/thread/:threadId/message/:messageId/poll-votes"]
  ]) {
    const block = route(path, nextPath);
    assert.ok(
      block.indexOf("prisma.message.findUnique") >
        block.indexOf("threadExternalActionFence.run")
    );
  }
});

test("send workers and every session reset share the same external-action lock vocabulary", () => {
  assert.match(source, /createSendService\([\s\S]*?withExternalActionLock/);
  assert.match(source, /createAdminResetCoordinator\([\s\S]*?withExternalActionLock/);
  assert.match(
    source,
    /createPlatformSessionResetCoordinator\([\s\S]*?withExternalActionLock[\s\S]*?withPlatformLock:\s*withPlatformControlLock/
  );
  assert.match(source, /sendLockKeyFor\(platform\)/);

  const reset = route("/control/platform/reset-session", "/control/system/restart");
  assert.match(reset, /platformSessionResetCoordinator\.reset\(payload\.platform\)/);
  assert.doesNotMatch(reset, /resetPersonSession|operationMutex\.runExclusive/);
});

test("WhatsApp connect, QR refresh and reset use the shared action then platform fence", () => {
  assert.match(
    source,
    /function withWhatsAppSessionLocks[\s\S]*?withExternalActionLock\("WHATSAPP"[\s\S]*?withPlatformControlLock\("WHATSAPP"/
  );
  for (const [path, nextPath] of [
    ["/control/whatsapp/connect", "/control/whatsapp/refresh-qr"],
    ["/control/whatsapp/refresh-qr", "/data/whatsapp/status"],
    ["/control/whatsapp/reset", "/data/link-preview"]
  ]) {
    const block = route(path, nextPath);
    assert.match(block, /withWhatsAppSessionLocks/);
  }
});

test("presenter demo cleanup is centralized behind every affected external fence", () => {
  assert.equal((source.match(/cleanupDemoData\(/g) ?? []).length, 1);
  assert.match(
    source,
    /createDemoCleanupCoordinator\([\s\S]*?withGlobalResetLock[\s\S]*?withExternalActionLock/
  );
  assert.match(
    source,
    /async function cleanupDemoManifest[\s\S]*?demoCleanupCoordinator\.run[\s\S]*?cleanupDemoData[\s\S]*?afterCleanup\(\)/
  );
});
