import assert from "node:assert/strict";
import test from "node:test";

const {
  assertThreadComposerAttachmentsRecoverable,
  createMemoryThreadComposerAttachmentStore,
  getOrCreateThreadComposerTabId
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
