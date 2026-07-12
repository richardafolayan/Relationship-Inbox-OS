import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageSource = () =>
  readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );

test("the chat column is a drop zone wired to the composer's addFiles", async () => {
  const source = await pageSource();
  assert.match(source, /onDragEnter=\{onComposerDragEnter\}/);
  assert.match(source, /onDragOver=\{onComposerDragOver\}/);
  assert.match(source, /onDragLeave=\{onComposerDragLeave\}/);
  assert.match(source, /onDrop=\{onComposerDrop\}/);
  assert.match(source, /\.filter\(isAttachableFile\);\s*\n\s*if \(files\.length > 0\) addFiles\(files\);/);
  assert.match(source, /data-testid="composer-drop-overlay"/);
  assert.match(source, /Drop to attach/);
});

test("drops are gated to attachment-capable platforms and safe file kinds", async () => {
  const source = await pageSource();
  assert.match(
    source,
    /composerAcceptsFiles =\s*\n?\s*thread\?\.platform === "IMESSAGE" \|\| thread\?\.platform === "WHATSAPP"/
  );
  assert.match(source, /mime\.startsWith\("image\/"\)/);
  assert.match(source, /mime === "application\/pdf"/);
});

test("a stray drop outside the zone can never navigate the app to the file", async () => {
  const source = await pageSource();
  assert.match(source, /window\.addEventListener\("dragover", prevent\)/);
  assert.match(source, /window\.addEventListener\("drop", prevent\)/);
});
