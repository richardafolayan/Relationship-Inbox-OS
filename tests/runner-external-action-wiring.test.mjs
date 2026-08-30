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

test("reaction, edit, and poll vote routes use durable external-action identity", () => {
  for (const [path, nextPath] of [
    ["/control/thread/:threadId/message/:messageId/react", "/control/thread/:threadId/message/:messageId/edit"],
    ["/control/thread/:threadId/message/:messageId/edit", "/control/thread/:threadId/message/:messageId/poll-vote"],
    ["/control/thread/:threadId/message/:messageId/poll-vote", "/control/thread/:threadId/message/:messageId/poll-votes"]
  ]) {
    const block = route(path, nextPath);
    assert.match(block, /durableExternalActionService\.execute\(/);
    assert.match(block, /DurableExternalActionError/);
    assert.match(block, /clientActionId:\s*z\.string\(\)\.uuid\(\)/);
  }
});

test("every user-triggered outbound message request registers intent before body parsing", () => {
  const registration = source.indexOf("app.use(registerUserTriggeredSendIntent)");
  assert.notEqual(registration, -1);
  assert.ok(registration < source.indexOf("const jsonSmall"));
  assert.match(source, /createUserTriggeredIntentMiddleware\([\s\S]*?resolveUserTriggeredIntentThreadId/);
  assert.match(source, /sendService\.registerDurableUserTriggeredIntent\(threadId\)/);

  for (const [path, nextPath] of [
    ["/control/thread/:threadId/send", "/control/thread/:threadId/send-poll"],
    ["/control/thread/:threadId/send-poll", "/control/thread/:threadId/update-send"],
    ["/control/thread/:threadId/retry-send", "/control/thread/:threadId/open"]
  ]) {
    const block = route(path, nextPath);
    assert.match(block, /beginUserTriggeredIntentOperation\(res\)/);
    assert.match(block, /finally\s*\{\s*completeUserTriggeredIntent\(\)/);
  }

  const profileRegistration = source.indexOf("app.use(registerFocusPolicyMutationIntent)");
  assert.notEqual(profileRegistration, -1);
  assert.ok(profileRegistration < source.indexOf("const jsonSmall"));
  const profileRoute = route(
    "/control/operator-profile",
    "/control/calendar/preview"
  );
  assert.match(profileRoute, /beginUserTriggeredIntentOperation\(res\)/);
  assert.match(profileRoute, /finally\s*\{\s*completeFocusPolicyMutation\(\)/);
});

test("external action status invokes the poll reconciler for manual poll rows", () => {
  const start = source.indexOf('app.get("/data/external-action-status/:clientId"');
  const end = source.indexOf('app.get("/data/people"', start + 1);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.match(block, /sendRequest\.source === "manual_poll"/);
  assert.match(block, /pollSendService\.reconcileSentProjections\(\)/);
});

test("durable external actions reconcile local projections during runner startup", () => {
  assert.match(source, /durableExternalActionService\.reconcileSentProjections\(\)/);
});

test("manual focus acknowledgement completion trusts only a delivered matching send", () => {
  const block = route(
    "/control/thread/:threadId/focus-ack/complete",
    "/control/thread/:threadId/open"
  );
  assert.match(
    block,
    /request\.source !== "focus_ack" && request\.source !== "focus_auto_ack"/
  );
  assert.match(block, /request\.status !== "SENT"/);
  assert.match(block, /profile\.focusWindow\.windowId !== payload\.focusWindowId/);
  assert.match(block, /request\.createdAt\.getTime\(\) < windowStartedAt/);
  assert.match(block, /focusAcknowledgementClientSendIds\(/);
  assert.match(
    block,
    /settingsStore\.acknowledgeFocusWindowPerson\(\s*payload\.focusWindowId,\s*request\.thread\.personId/
  );
  assert.doesNotMatch(block, /setOperatorProfile|updateOperatorProfile/);
});

test("retry-safe manual focus acknowledgements reuse the deterministic send id", () => {
  const block = route(
    "/control/thread/:threadId/retry-send",
    "/control/thread/:threadId/focus-ack/complete"
  );
  assert.match(block, /originalSource === "focus_auto_ack"/);
  assert.match(block, /automatic_focus_ack_retry_not_operator_triggered/);
  assert.match(block, /focusManualAckClientSendId\(/);
  assert.match(block, /clientSendId: original\.clientSendId/);
  assert.match(block, /source: "focus_ack"/);
  assert.match(block, /focusWindowId: profile\.focusWindow\.windowId/);
});

test("the queue summary excludes durable non-message action rows", () => {
  const start = source.indexOf('app.get("/data/send-queue"');
  const end = source.indexOf('app.get("/data/send-status/:clientSendId"', start);
  const block = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal((block.match(/source: \{ in: QUEUED_MESSAGE_SOURCES \}/g) ?? []).length, 2);
  assert.doesNotMatch(block, /manual_poll/);
});

test("attempt scopes are replaced only after local projection reconciliation", () => {
  const start = source.indexOf('app.get("/data/external-action-status/:clientId"');
  const end = source.indexOf('app.get("/data/people"', start);
  const block = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(block, /needsLocalReconciliation\(sendRequest\.errorJson\)/);
  assert.match(block, /sendService\.reconcileSentProjections\(\)/);
  assert.match(block, /durableExternalActionService\.reconcileSentProjections\(\)/);
  assert.match(
    block,
    /exactlyOneRecord && record\?\.status === "SENT" && record\.errorJson === null/
  );
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
