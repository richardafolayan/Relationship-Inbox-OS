import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const helperSource = await readFile(
  new URL("../apps/dashboard/lib/instagram-recipient-safety.ts", import.meta.url),
  "utf8"
);
const helperJavascript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { instagramRecipientSafety, normalizeRecipientIdentity } = await import(
  `data:text/javascript;base64,${Buffer.from(helperJavascript).toString("base64")}`
);

test("recipient identity comparison normalizes compatibility, case and whitespace", () => {
  assert.equal(normalizeRecipientIdentity("  Ａnn\tSMITH  "), "ann smith");
  assert.equal(
    instagramRecipientSafety({
      platform: "INSTAGRAM",
      personName: "Ann Smith",
      recipientVerificationLabel: "  ＡNN   smith "
    }).blocked,
    false
  );
});

test("Instagram uses the authoritative platform recipient when the contact link matches", () => {
  assert.deepEqual(
    instagramRecipientSafety({
      platform: "INSTAGRAM",
      personName: "Ann Smith",
      recipientVerificationLabel: "Ann Smith"
    }),
    {
      blocked: false,
      blockReason: null,
      displayName: "Ann Smith",
      linkedContactName: null,
      platformRecipientLabel: "Ann Smith"
    }
  );
});

test("Instagram keeps an operator alias separate from platform recipient evidence", () => {
  const result = instagramRecipientSafety({
    platform: "INSTAGRAM",
    personName: "Linked Contact",
    recipientVerificationLabel: "Platform Recipient"
  });

  assert.equal(result.blocked, false);
  assert.equal(result.displayName, "Platform Recipient");
  assert.equal(result.linkedContactName, "Linked Contact");
  assert.equal(result.blockReason, null);
});

test("Instagram blocks send when the platform recipient is unavailable", () => {
  const result = instagramRecipientSafety({
    platform: "INSTAGRAM",
    personName: "Linked Contact",
    recipientVerificationLabel: "  "
  });

  assert.equal(result.blocked, true);
  assert.equal(result.displayName, "Instagram recipient unavailable");
  assert.equal(result.linkedContactName, "Linked Contact");
  assert.equal(result.platformRecipientLabel, null);
});

test("non-Instagram threads keep their linked contact display and send state", () => {
  assert.deepEqual(
    instagramRecipientSafety({
      platform: "LINKEDIN",
      personName: "Linked Contact",
      recipientVerificationLabel: "Ignored Label"
    }),
    {
      blocked: false,
      blockReason: null,
      displayName: "Linked Contact",
      linkedContactName: null,
      platformRecipientLabel: null
    }
  );
});

test("thread page shows the platform recipient and gates every composer send entry point", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /data-testid="instagram-recipient-safety"/);
  assert.match(source, /Instagram recipient/);
  assert.match(source, /Linked contact:/);
  assert.match(source, /composerRecoveryVisible \|\|\s*recipientSafety\.blocked/);
  assert.match(source, /if \(recipientSafety\.blocked\) \{\s*setError\(recipientSafety\.blockReason\)/);
  assert.match(
    source,
    /thread\.platform !== "INSTAGRAM" && !recipientSafety\.blocked \? \(\s*<FocusThreadStrip/
  );
  assert.equal(
    (source.match(/composerExternalActionBlocked \|\|/g) ?? []).length >= 2,
    true
  );
});

test("dictated-message send checks the Instagram recipient before durable claim or dispatch", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("const sendDictationMessage = useCallback");
  const end = source.indexOf("// Cmd/Ctrl-Enter sends.", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const sendDictationMessage = source.slice(start, end);

  const recipientCheck = sendDictationMessage.indexOf(
    "const recipientSafety = instagramRecipientSafety(thread)"
  );
  const durableClaim = sendDictationMessage.indexOf(
    "externalActionAttempts.getOrCreateScopedValue"
  );
  const dispatch = sendDictationMessage.indexOf(
    "`/runner/control/thread/${thread.id}/send`"
  );

  assert.notEqual(recipientCheck, -1);
  assert.ok(recipientCheck < durableClaim);
  assert.ok(durableClaim < dispatch);
  assert.match(
    sendDictationMessage,
    /if \(recipientSafety\.blocked\) \{[\s\S]*?throw new Error/
  );
});

test("all composer dispatch and replay paths share the recipient preflight", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("const dispatchComposerSendAttempt = useCallback");
  const end = source.indexOf("const refreshThread", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const dispatcher = source.slice(start, end);

  const recipientCheck = dispatcher.indexOf(
    "const recipientSafety = instagramRecipientSafety(thread)"
  );
  const firstDispatch = dispatcher.indexOf("apiPost");
  assert.notEqual(recipientCheck, -1);
  assert.ok(recipientCheck < firstDispatch);
  assert.match(dispatcher, /if \(recipientSafety\.blocked\) \{[\s\S]*?throw new Error/);
});
