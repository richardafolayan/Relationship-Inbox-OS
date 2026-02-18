import test from "node:test";
import assert from "node:assert/strict";
import {
  createSelectorTestService,
  isSelectorTestServiceError
} from "../apps/runner/dist/services/selector-tests.js";

test("selector test failure contract always includes minimum error shape", async () => {
  const service = createSelectorTestService({
    resolveSelectors: async () => ({
      inbox_url: "https://www.linkedin.com/messaging/",
      thread_list: ".thread-list",
      thread_item: ".thread-item",
      unread_badge: ".unread",
      message_container: ".message-container",
      message_item: ".message-item",
      message_text: ".message-text",
      composer_input: ".composer",
      send_button: ".send"
    }),
    sessionManager: {
      getManagedPage: async () => {
        throw new Error("context launch failed");
      }
    },
    screenshotDir: "/tmp",
    domDumpDir: "/tmp"
  });

  await assert.rejects(
    async () => service.run({ platform: "LINKEDIN" }),
    (error) => {
      assert.equal(isSelectorTestServiceError(error), true);
      const payload = error.payload;
      assert.equal(payload.ok, false);
      assert.equal(payload.platform, "LINKEDIN");
      assert.equal(typeof payload.stage, "string");
      assert.equal(typeof payload.error, "string");
      assert.equal(typeof payload.requestId, "string");
      assert.ok(Array.isArray(payload.receipts));
      return true;
    }
  );
});
