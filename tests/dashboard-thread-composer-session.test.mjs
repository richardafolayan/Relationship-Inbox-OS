import assert from "node:assert/strict";
import test from "node:test";

const {
  clearThreadComposerSession,
  readThreadComposerSession,
  writeThreadComposerSession,
  __test
} = await import("../apps/dashboard/lib/thread-composer-session.ts");

function makeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
}

test("composer sessions keep unsent text isolated by thread", () => {
  const storage = makeStorage();
  writeThreadComposerSession("thread-a", { text: "reply for A", source: "user" }, storage);
  writeThreadComposerSession("thread-b", { text: "reply for B", source: "draft" }, storage);
  assert.deepEqual(readThreadComposerSession("thread-a", storage), {
    text: "reply for A",
    source: "user"
  });
  assert.deepEqual(readThreadComposerSession("thread-b", storage), {
    text: "reply for B",
    source: "draft"
  });
});

test("clearing one composer session never clears another", () => {
  const storage = makeStorage();
  writeThreadComposerSession("thread-a", { text: "A", source: "user" }, storage);
  writeThreadComposerSession("thread-b", { text: "B", source: "user" }, storage);
  clearThreadComposerSession("thread-a", storage);
  assert.equal(readThreadComposerSession("thread-a", storage), null);
  assert.equal(readThreadComposerSession("thread-b", storage)?.text, "B");
});

test("empty text removes private recovery data and malformed records are ignored", () => {
  const storage = makeStorage();
  writeThreadComposerSession("thread-a", { text: "A", source: "user" }, storage);
  writeThreadComposerSession("thread-a", { text: "", source: "empty" }, storage);
  assert.equal(storage.data.has(__test.keyFor("thread-a")), false);
  storage.data.set(__test.keyFor("thread-a"), '{"text":"A","source":"unknown"}');
  assert.equal(readThreadComposerSession("thread-a", storage), null);
});

test("storage failures never interrupt composing", () => {
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("full"); },
    removeItem: () => { throw new Error("blocked"); }
  };
  assert.equal(readThreadComposerSession("thread-a", storage), null);
  assert.doesNotThrow(() => writeThreadComposerSession("thread-a", { text: "A", source: "user" }, storage));
  assert.doesNotThrow(() => clearThreadComposerSession("thread-a", storage));
});
