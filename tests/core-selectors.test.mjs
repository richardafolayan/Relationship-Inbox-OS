import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadDefaultSelectors, resolveSelectors } from "../packages/core/dist/selectors.js";

const selectorDir = fileURLToPath(new URL("../packages/core/selectors", import.meta.url));

test("resolveSelectors merges DB overrides on top of defaults", () => {
  const defaults = loadDefaultSelectors("LINKEDIN", selectorDir);
  const resolved = resolveSelectors("LINKEDIN", selectorDir, {
    LINKEDIN: {
      thread_list: ".custom-thread-list"
    }
  });

  assert.equal(resolved.thread_list, ".custom-thread-list");
  assert.equal(resolved.send_button, defaults.send_button);
  assert.equal(resolved.inbox_url, defaults.inbox_url);
});

test("resolveSelectors returns defaults when no override exists", () => {
  const defaults = loadDefaultSelectors("INSTAGRAM", selectorDir);
  const resolved = resolveSelectors("INSTAGRAM", selectorDir, {});

  assert.deepEqual(resolved, defaults);
});

test("resolveSelectors normalizes legacy LinkedIn thread_list override", () => {
  const resolved = resolveSelectors("LINKEDIN", selectorDir, {
    LINKEDIN: {
      thread_list: "ul.msg-conversations-container"
    }
  });

  assert.equal(resolved.thread_list, "ul.msg-conversations-container__conversations-list");
});
