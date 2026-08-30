import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer";

test("real IndexedDB preserves cloned holders, compacts reloads, and quarantines orphans", async (t) => {
  const bundle = await build({
    bundle: true,
    entryPoints: [
      new URL(
        "../apps/dashboard/lib/thread-composer-attachments.ts",
        import.meta.url
      ).pathname
    ],
    format: "iife",
    globalName: "ComposerAttachments",
    platform: "browser",
    write: false
  });
  const script = bundle.outputFiles[0].text;
  const server = createServer((request, response) => {
    if (request.url === "/composer-attachments.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><script src="/composer-attachments.js"></script>'
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const browser = await puppeteer.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);

  const result = await page.evaluate(async () => {
    const {
      __test,
      createIndexedDbThreadComposerAttachmentStore
    } = globalThis.ComposerAttachments;
    let now = 1_000;
    const clock = () => now;
    const descriptor = {
      id: "attachment-1",
      kind: "pdf",
      lastModified: 123,
      name: "pilot-notes.pdf",
      size: 16,
      type: "application/pdf"
    };
    const file = new File(["pilot attachment"], descriptor.name, {
      lastModified: descriptor.lastModified,
      type: descriptor.type
    });
    const ownerRows = async (threadId) => {
      const database = await __test.openDatabase(indexedDB);
      const transaction = database.transaction(__test.OWNERS_STORE, "readonly");
      const request = transaction.objectStore(__test.OWNERS_STORE).getAll();
      const rows = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return rows.filter((row) => row.threadId === threadId);
    };

    const tabA = createIndexedDbThreadComposerAttachmentStore(
      indexedDB,
      "cloned-namespace",
      clock,
      "holder-a"
    );
    const tabB = createIndexedDbThreadComposerAttachmentStore(
      indexedDB,
      "cloned-namespace",
      clock,
      "holder-b"
    );
    await tabA.put("thread-clone", descriptor, file);
    await tabA.claimOwnership("thread-clone", [descriptor.id], "session-x");
    await tabB.claimOwnership("thread-clone", [descriptor.id], "session-x");
    await tabA.releaseOwnership("thread-clone", "session-x");
    await tabA.removeUnowned("thread-clone", [descriptor.id]);
    const clonedReadCount = (
      await tabB.read("thread-clone", [descriptor])
    ).length;
    const clonedOwnerCount = (await ownerRows("thread-clone")).length;

    const reloadDescriptor = { ...descriptor, id: "attachment-reload" };
    await tabA.put("thread-reload", reloadDescriptor, file);
    for (let index = 0; index < 8; index += 1) {
      now += 1;
      const reloaded = createIndexedDbThreadComposerAttachmentStore(
        indexedDB,
        "reload-namespace",
        clock,
        `reload-holder-${index}`
      );
      await reloaded.claimOwnership(
        "thread-reload",
        [reloadDescriptor.id],
        "session-reload"
      );
    }
    now += __test.STALE_AFTER_MS + 1;
    const newest = createIndexedDbThreadComposerAttachmentStore(
      indexedDB,
      "reload-namespace",
      clock,
      "reload-holder-newest"
    );
    await newest.claimOwnership(
      "thread-reload",
      [reloadDescriptor.id],
      "session-reload"
    );
    await newest.purgeStale(
      (threadId, ownerId) =>
        threadId === "thread-reload" && ownerId === "session-reload"
    );
    const reloadOwnerCount = (await ownerRows("thread-reload")).length;

    const quarantineDescriptor = { ...descriptor, id: "attachment-quarantine" };
    const quarantine = createIndexedDbThreadComposerAttachmentStore(
      indexedDB,
      "quarantine-namespace",
      clock,
      "quarantine-holder"
    );
    await quarantine.put("thread-off-route", quarantineDescriptor, file);
    await quarantine.claimOwnership(
      "thread-off-route",
      [quarantineDescriptor.id],
      "session-live"
    );
    now += __test.STALE_AFTER_MS + 1;
    await quarantine.purgeStale(
      (threadId, ownerId) =>
        threadId === "thread-off-route" && ownerId === "session-live"
    );
    const liveReadCount = (
      await quarantine.read("thread-off-route", [quarantineDescriptor])
    ).length;
    now += __test.STALE_AFTER_MS + 1;
    await quarantine.purgeStale(() => false);
    const quarantinedReadCount = (
      await quarantine.read("thread-off-route", [quarantineDescriptor])
    ).length;
    now += __test.STALE_AFTER_MS + 1;
    await quarantine.purgeStale(() => false);
    const expiredReadCount = (
      await quarantine.read("thread-off-route", [quarantineDescriptor])
    ).length;

    return {
      clonedOwnerCount,
      clonedReadCount,
      expiredReadCount,
      liveReadCount,
      quarantinedReadCount,
      reloadOwnerCount
    };
  });

  assert.deepEqual(result, {
    clonedOwnerCount: 1,
    clonedReadCount: 1,
    expiredReadCount: 0,
    liveReadCount: 1,
    quarantinedReadCount: 1,
    reloadOwnerCount: 1
  });
});
