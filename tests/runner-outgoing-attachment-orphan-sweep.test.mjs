import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  sweepOutgoingAttachmentOrphans
} from "../apps/runner/dist/services/outgoing-attachment-orphan-sweep.js";

function lineReader(stream) {
  let buffer = "";
  const lines = [];
  const waiting = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(line);
      else lines.push(line);
    }
  });
  return () => new Promise((resolve) => {
    if (lines.length > 0) {
      resolve(lines.shift());
      return;
    }
    waiting.push(resolve);
  });
}

async function writeReferenced(root, name) {
  const directory = join(root, name);
  const path = join(directory, `${name}.txt`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, name);
  return { directory, path };
}

test("startup sweep removes a crashed multipart orphan and preserves every referenced status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tovi-outgoing-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [new URL("./fixtures/staged-attachment-crash-child.mjs", import.meta.url).pathname, root],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const nextLine = lineReader(child.stdout);
  const portLine = await nextLine();
  assert.match(portLine, /^port:\d+$/);
  const port = Number(portLine.slice("port:".length));
  const form = new FormData();
  form.set("attachments", new Blob(["private orphan"]), "orphan.txt");
  const uploadRequest = fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    body: form
  }).catch(() => undefined);
  const uploadedLine = await nextLine();
  assert.match(uploadedLine, /^uploaded:/);
  const orphanPath = uploadedLine.slice("uploaded:".length);
  child.kill("SIGKILL");
  await once(child, "exit");
  await uploadRequest;
  assert.equal(await readFile(orphanPath, "utf8"), "private orphan");

  const controls = await Promise.all(
    ["pending", "scheduled", "failed"].map((name) => writeReferenced(root, name))
  );
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await Promise.all([
    utimes(join(root, "crashed-upload"), old, old),
    ...controls.map(({ directory }) => utimes(directory, old, old))
  ]);

  const result = await sweepOutgoingAttachmentOrphans({
    outgoingAttachmentsRoot: root,
    graceMs: 60 * 60 * 1000,
    loadRows: async () => controls.map(({ path }, index) => ({
      attachmentsJson: JSON.stringify([{ absolutePath: path }]),
      status: ["PENDING", "SCHEDULED", "FAILED"][index]
    }))
  });
  assert.deepEqual(result, { status: "completed", removed: 1 });
  await assert.rejects(() => stat(join(root, "crashed-upload")), { code: "ENOENT" });
  for (const [index, control] of controls.entries()) {
    assert.equal(await readFile(control.path, "utf8"), ["pending", "scheduled", "failed"][index]);
  }
});

test("database and JSON uncertainty abort before deleting any orphan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tovi-outgoing-sweep-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = await writeReferenced(root, "candidate");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(candidate.directory, old, old);

  assert.deepEqual(
    await sweepOutgoingAttachmentOrphans({
      outgoingAttachmentsRoot: root,
      graceMs: 60 * 60 * 1000,
      loadRows: async () => {
        throw new Error("database unavailable");
      }
    }),
    { status: "aborted", removed: 0 }
  );
  assert.equal(await readFile(candidate.path, "utf8"), "candidate");

  assert.deepEqual(
    await sweepOutgoingAttachmentOrphans({
      outgoingAttachmentsRoot: root,
      graceMs: 60 * 60 * 1000,
      loadRows: async () => [{ attachmentsJson: "not-json" }]
    }),
    { status: "aborted", removed: 0 }
  );
  assert.equal(await readFile(candidate.path, "utf8"), "candidate");
});

test("runner startup sweeps before accepting work", async () => {
  const source = await readFile(
    new URL("../apps/runner/src/index.ts", import.meta.url),
    "utf8"
  );
  const start = source.slice(source.indexOf("async function start(): Promise<void>"));
  assert.ok(
    start.indexOf("sweepOutgoingAttachmentOrphansOnce()") <
      start.indexOf("scanQueue.startScheduler()")
  );
  assert.match(
    source,
    /loadRows: \(\) => prisma\.sendRequest\.findMany\(\{\s*select: \{ attachmentsJson: true \}/
  );
  assert.match(
    start,
    /setInterval\([\s\S]*?sweepOutgoingAttachmentOrphansOnce\(\)[\s\S]*?OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS[\s\S]*?\.unref\(\)/
  );
});
