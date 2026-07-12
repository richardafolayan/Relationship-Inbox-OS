import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewer = readFileSync(
  new URL("../apps/dashboard/components/thread/photo-viewer.tsx", import.meta.url),
  "utf8"
);
const imessage = readFileSync(
  new URL("../apps/dashboard/components/thread/imessage-media.tsx", import.meta.url),
  "utf8"
);
const whatsapp = readFileSync(
  new URL("../apps/dashboard/components/thread/whatsapp-media.tsx", import.meta.url),
  "utf8"
);

test("photo viewer provides visible, keyboard, and backdrop exit paths", () => {
  assert.match(viewer, />\s*Close\s*</);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(viewer, /event\.target === event\.currentTarget/);
  assert.match(viewer, /role="dialog"/);
  assert.match(viewer, /aria-modal="true"/);
});

test("message photos use the in-app viewer instead of blank image windows", () => {
  assert.match(imessage, /<PhotoViewer/);
  assert.match(whatsapp, /<PhotoViewer/);
  assert.doesNotMatch(imessage, /target="_blank"[^>]*>\s*<PhotoViewer/);
  assert.doesNotMatch(whatsapp, /target="_blank"[^>]*>\s*<PhotoViewer/);
});
