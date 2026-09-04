import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the core adapter contract and send service require a final dispatch boundary", async () => {
  const [contract, service] = await Promise.all([
    read("../packages/core/src/adapters.ts"),
    read("../apps/runner/src/services/send.ts")
  ]);
  assert.match(contract, /beforeDispatch: \(\) => Promise<void>/);
  assert.match(service, /const beforeDispatch = async \(\) =>/);
  assert.match(service, /adapter\.sendMessage\([\s\S]*?stagedAttachments[\s\S]*?beforeDispatch\s*\)/);
  assert.ok(service.indexOf("dispatchStarted = true") > service.indexOf("await assertFocusAutoAckDispatchEligible?.()"));
});

test("browser adapters authorize immediately before their first outbound mutation", async () => {
  const [beta, google, instagram, linkedin] = await Promise.all([
    read("../apps/runner/src/platforms/beta-adapter.ts"),
    read("../apps/runner/src/platforms/google-messages-adapter.ts"),
    read("../apps/runner/src/platforms/instagram-adapter.ts"),
    read("../apps/runner/src/platforms/linkedin-adapter.ts")
  ]);

  for (const source of [beta, linkedin]) {
    const block = source.slice(source.indexOf("async sendMessage("), source.indexOf("async openThread(", source.indexOf("async sendMessage(")));
    assert.match(block, /humanClick\(page, sendBtn,[\s\S]*?beforeClick: async \(\) => \{\s*await beforeDispatch\?\.\(\)/);
    assert.doesNotMatch(block, /keyboard\.press\(["']Enter["']\)/);
  }

  const googleBlock = google.slice(google.indexOf("async sendMessage("), google.indexOf("async reactToMessage(", google.indexOf("async sendMessage(")));
  assert.ok(googleBlock.indexOf("setInputFiles(files)") < googleBlock.indexOf("await authorizeDispatch()"));
  assert.ok(googleBlock.indexOf("await authorizeDispatch()") < googleBlock.indexOf("await send.click()"));

  const instagramBlock = instagram.slice(instagram.indexOf("async sendMessage("), instagram.indexOf("async openThread(", instagram.indexOf("async sendMessage(")));
  const instagramAuthorization = instagramBlock.indexOf("await beforeDispatch?.()");
  const instagramCaptureStart = instagramBlock.indexOf(
    "sendCaptureGeneration = this.beginNetworkSendCapture",
    instagramAuthorization
  );
  const instagramUncertainty = instagramBlock.indexOf(
    "submissionMayHaveOccurred = true",
    instagramCaptureStart
  );
  const instagramSendMutation = instagramBlock.indexOf(
    'action: "send"',
    instagramUncertainty
  );
  assert.ok(instagramAuthorization >= 0);
  assert.ok(instagramAuthorization < instagramCaptureStart);
  assert.ok(instagramCaptureStart < instagramUncertainty);
  assert.ok(instagramUncertainty < instagramSendMutation);
});

test("iMessage stages attachments before authorization and mutates Messages only afterwards", async () => {
  const source = await read("../apps/runner/src/platforms/imessage-send.ts");
  const block = source.slice(source.indexOf("export async function sendIMessage(opts"));
  const preparation = block.indexOf("preparedAttachmentPaths.push");
  const authorization = block.indexOf("await opts.beforeDispatch?.()");
  const attachmentSend = block.indexOf("await sendFileViaUiScripting");
  const textSend = block.indexOf('await execFileAsync("osascript"');
  assert.ok(preparation < authorization);
  assert.ok(authorization < attachmentSend);
  assert.ok(authorization < textSend);
});
