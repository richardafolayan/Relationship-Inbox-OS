import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// #823 (R-0105): dragging files anywhere over the chat column stages them
// as composer attachments, matching the feedback form's drag surface. The
// thread page is one large client component with no headless harness, so
// these are structural pins on the wiring that must not silently regress.

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
  // The drop handler stages the files through the same path as the
  // paperclip picker.
  assert.match(source, /\.filter\(isAttachableFile\);\s*\n\s*if \(files\.length > 0\) addFiles\(files\);/);
  // Visual affordance while dragging.
  assert.match(source, /data-testid="composer-drop-overlay"/);
  assert.match(source, /Drop to attach/);
});

test("drops are gated to attachment-capable platforms and safe file kinds", async () => {
  const source = await pageSource();
  // Same platform gate as the paperclip button.
  assert.match(
    source,
    /composerAcceptsFiles =\s*\n?\s*thread\?\.platform === "IMESSAGE" \|\| thread\?\.platform === "WHATSAPP"/
  );
  // Same accept filter as the paperclip <input>.
  assert.match(source, /mime\.startsWith\("image\/"\)/);
  assert.match(source, /mime === "application\/pdf"/);
});

test("a stray drop outside the zone can never navigate the app to the file", async () => {
  const source = await pageSource();
  // Window-level guard: files dragged over / dropped on the window have
  // their default (navigate-to-file) behaviour suppressed.
  assert.match(source, /window\.addEventListener\("dragover", prevent\)/);
  assert.match(source, /window\.addEventListener\("drop", prevent\)/);
});
