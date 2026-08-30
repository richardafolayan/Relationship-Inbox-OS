import assert from "node:assert/strict";
import test from "node:test";

const {
  assertThreadComposerAttachmentsRecoverable,
  createMemoryThreadComposerAttachmentStore,
  getOrCreateThreadComposerTabId,
  removableThreadComposerAttachmentIds,
  __test
} = await import("../apps/dashboard/lib/thread-composer-attachments.ts");

const descriptor = {
  id: "attachment-1",
  kind: "pdf",
  lastModified: 123,
  name: "pilot-notes.pdf",
  size: 16,
  type: "application/pdf"
};

test("attachment recovery preserves bytes and file identity", async () => {
  const store = createMemoryThreadComposerAttachmentStore();
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });
  assert.equal(file.size, descriptor.size);

  await store.put("thread-a", descriptor, file);
  const recovered = await store.read("thread-a", [descriptor]);

  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].descriptor, descriptor);
  assert.equal(recovered[0].file.name, descriptor.name);
  assert.equal(recovered[0].file.lastModified, descriptor.lastModified);
  assert.equal(recovered[0].file.type, descriptor.type);
  assert.equal(await recovered[0].file.text(), "pilot attachment");
});

test("attachment recovery is thread-scoped and validates metadata", async () => {
  const store = createMemoryThreadComposerAttachmentStore();
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });
  await store.put("thread-a", descriptor, file);

  assert.deepEqual(await store.read("thread-b", [descriptor]), []);
  assert.deepEqual(
    await store.read("thread-a", [{ ...descriptor, size: descriptor.size + 1 }]),
    []
  );
});

test("consumed or discarded attachments cannot be recovered", async () => {
  const store = createMemoryThreadComposerAttachmentStore();
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });
  await store.put("thread-a", descriptor, file);
  await store.remove("thread-a", [descriptor.id]);
  assert.deepEqual(await store.read("thread-a", [descriptor]), []);
});

test("completion preserves attachment bytes still referenced by a newer composer generation", () => {
  const completed = [descriptor, { ...descriptor, id: "attachment-2" }];
  const newer = [{ ...descriptor, name: "still-in-the-composer.pdf" }];

  assert.deepEqual(
    removableThreadComposerAttachmentIds(completed, newer),
    ["attachment-2"]
  );
});

test("external actions wait for a verified recoverable attachment copy", async () => {
  const store = createMemoryThreadComposerAttachmentStore();
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });

  await assert.rejects(
    assertThreadComposerAttachmentsRecoverable(store, "thread-a", [descriptor]),
    /could not be saved for recovery/
  );

  await store.put("thread-a", descriptor, file);
  await assert.doesNotReject(
    assertThreadComposerAttachmentsRecoverable(store, "thread-a", [descriptor])
  );
});

test("a shared attempt can recover attachment bytes from its originating namespace", async () => {
  const store = createMemoryThreadComposerAttachmentStore("tab-b");
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });
  await store.put("thread-a", descriptor, file, "attempt-from-tab-a");

  assert.deepEqual(await store.read("thread-a", [descriptor]), []);
  const recovered = await store.read(
    "thread-a",
    [descriptor],
    "attempt-from-tab-a"
  );
  assert.equal(await recovered[0].file.text(), "pilot attachment");
  await store.remove("thread-a", [descriptor.id], "attempt-from-tab-a");
  assert.deepEqual(
    await store.read("thread-a", [descriptor], "attempt-from-tab-a"),
    []
  );
});

test("one tab cannot delete attachment bytes still owned by another tab", async () => {
  let now = 1_000;
  const store = createMemoryThreadComposerAttachmentStore("shared-namespace", () => now);
  const file = new File(["pilot attachment"], descriptor.name, {
    lastModified: descriptor.lastModified,
    type: descriptor.type
  });
  await store.put("thread-a", descriptor, file);
  await store.claimOwnership("thread-a", [descriptor.id], "tab-a:session-x");
  await store.claimOwnership("thread-a", [descriptor.id], "tab-b:session-y");

  await store.releaseOwnership("thread-a", "tab-a:session-x");
  await store.removeUnowned("thread-a", [descriptor.id]);
  assert.equal((await store.read("thread-a", [descriptor])).length, 1);

  await store.releaseOwnership("thread-a", "tab-b:session-y");
  await store.removeUnowned("thread-a", [descriptor.id]);
  assert.equal((await store.read("thread-a", [descriptor])).length, 1);

  now += __test.STALE_AFTER_MS + 1;
  await store.removeUnowned("thread-a", [descriptor.id]);
  assert.deepEqual(await store.read("thread-a", [descriptor]), []);
});

test("a blocked IndexedDB upgrade rejects instead of hanging attachment recovery", async () => {
  const request = {};
  const opening = __test.openDatabase({
    open() {
      queueMicrotask(() => request.onblocked());
      return request;
    }
  });

  await assert.rejects(opening, /Close other Tovi windows, then reload/);
});

test("an open attachment database closes when another version upgrade begins", async () => {
  let closes = 0;
  const database = { close: () => { closes += 1; } };
  const request = { result: database };
  const opening = __test.openDatabase({
    open() {
      queueMicrotask(() => request.onsuccess());
      return request;
    }
  });

  assert.equal(await opening, database);
  database.onversionchange();
  assert.equal(closes, 1);
});

test("a tab keeps its recovery namespace without sharing a generated id", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value)
  };
  let generated = 0;
  const first = getOrCreateThreadComposerTabId(storage, () => `tab-${++generated}`);
  const second = getOrCreateThreadComposerTabId(storage, () => `tab-${++generated}`);
  assert.equal(first, "tab-1");
  assert.equal(second, "tab-1");
  assert.equal(generated, 1);
});
