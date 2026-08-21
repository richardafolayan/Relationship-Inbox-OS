import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetPlatformPrivateMedia } from "../apps/runner/dist/services/admin-reset.js";

test("platform reset deletes only its confined cached and staged private media", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-reset-media-"));
  const dataRoot = join(root, "data");
  const outgoingRoot = join(dataRoot, "outgoing-attachments");
  const stagedDir = join(outgoingRoot, "request-1");
  const stagedFile = join(stagedDir, "photo.jpg");
  const cacheRoot = join(dataRoot, "whatsapp-media");
  const cachedFile = join(cacheRoot, "private.jpg");
  const outsideFile = join(root, "must-stay.txt");
  await mkdir(stagedDir, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(stagedFile, "private", "utf8");
  await writeFile(cachedFile, "private", "utf8");
  await writeFile(outsideFile, "keep", "utf8");

  const result = await resetPlatformPrivateMedia({
    rows: [
      {
        attachmentsJson: JSON.stringify([
          { absolutePath: stagedFile },
          { absolutePath: outsideFile }
        ])
      }
    ],
    scope: { dataRoot, outgoingAttachmentsRoot: outgoingRoot, platformCacheRoot: cacheRoot }
  });

  assert.deepEqual(result, {
    removedCacheRoots: 1,
    removedStagedPaths: 1,
    skippedUnsafePaths: 1
  });
  await assert.rejects(() => stat(stagedFile));
  await assert.rejects(() => stat(cacheRoot));
  assert.equal((await stat(outsideFile)).isFile(), true);
});

test("platform reset refuses an unconstrained media cache root", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-reset-media-unsafe-"));
  const dataRoot = join(root, "data");
  const outgoingRoot = join(dataRoot, "outgoing-attachments");
  await mkdir(outgoingRoot, { recursive: true });
  await assert.rejects(
    () =>
      resetPlatformPrivateMedia({
        rows: [],
        scope: {
          dataRoot,
          outgoingAttachmentsRoot: outgoingRoot,
          platformCacheRoot: root
        }
      }),
    /cache root must be confined/
  );
});

test("platform reset rejects an outgoing root symlink that escapes the data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-reset-media-symlink-"));
  const dataRoot = join(root, "data");
  const outsideRoot = join(root, "outside");
  const outgoingRoot = join(dataRoot, "outgoing-attachments");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await symlink(outsideRoot, outgoingRoot);
  await assert.rejects(
    () =>
      resetPlatformPrivateMedia({
        rows: [],
        scope: { dataRoot, outgoingAttachmentsRoot: outgoingRoot }
      }),
    /resolves outside/
  );
});
