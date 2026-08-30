import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import express from "express";
import multer from "multer";
import { z } from "zod";

import {
  createStagedAttachmentRequestLifecycle,
  multipartOnly
} from "../apps/runner/dist/services/staged-attachment-request.js";

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
    next.on("error", reject);
  });
  return server;
}

async function uploadedFiles(root) {
  const directories = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const children = await readdir(join(root, directory.name));
    for (const child of children) files.push(join(root, directory.name, child));
  }
  return files;
}

function multipart(mode, clientSendId) {
  const form = new FormData();
  form.set("mode", mode);
  form.set("clientSendId", clientSendId);
  form.set("attachments", new Blob(["attachment bytes"]), "note.txt");
  return form;
}

test("multipart request lifecycle deletes pre-persistence failures and preserves unknown ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tovi-staged-route-"));
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let uploadNumber = 0;
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, callback) => {
        const destination = join(root, String(++uploadNumber));
        await mkdir(destination, { recursive: true });
        callback(null, destination);
      },
      filename: (_req, file, callback) => callback(null, file.originalname)
    })
  }).array("attachments", 1);

  const app = express();
  app.post("/send", multipartOnly(upload), (req, res, next) => {
    void (async () => {
      const lifecycle = createStagedAttachmentRequestLifecycle(req, {
        discard: async (attachments) => {
          await Promise.all(
            attachments.map((attachment) =>
              rm(dirname(attachment.absolutePath), { recursive: true, force: true })
            )
          );
        },
        resolveOwnership: async () => {
          throw new Error("database unavailable after insert");
        }
      });
      let status = 204;
      try {
        const payload = z.object({
          clientSendId: z.string().uuid(),
          mode: z.enum(["digest-failure", "ownership-unknown"])
        }).parse(req.body);
        const [file] = req.files;
        if (payload.mode === "digest-failure") {
          await rm(file.path);
          await readFile(file.path);
        }
        lifecycle.markPersistenceAttempted(payload.clientSendId);
        throw new Error("enqueue response was lost");
      } catch (error) {
        status = error instanceof z.ZodError ? 400 : 500;
      } finally {
        await lifecycle.finalize();
      }
      res.status(status).end();
    })().catch(next);
  });

  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/send`;

  const invalid = await fetch(url, {
    method: "POST",
    body: multipart("digest-failure", "not-a-uuid")
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await uploadedFiles(root), []);

  const digestFailure = await fetch(url, {
    method: "POST",
    body: multipart("digest-failure", "44c44306-517c-484b-9076-9915fa21163e")
  });
  assert.equal(digestFailure.status, 500);
  assert.deepEqual(await uploadedFiles(root), []);

  const ownershipUnknown = await fetch(url, {
    method: "POST",
    body: multipart("ownership-unknown", "550c8686-984a-4ddf-99ab-d2cdd7678c62")
  });
  assert.equal(ownershipUnknown.status, 500);
  const preserved = await uploadedFiles(root);
  assert.equal(preserved.length, 1);
  assert.equal(await readFile(preserved[0], "utf8"), "attachment bytes");
});
