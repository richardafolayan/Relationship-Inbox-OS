import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fallback = readFileSync(
  new URL("../apps/dashboard/components/thread/media-fallback.tsx", import.meta.url),
  "utf8"
);
const photoViewer = readFileSync(
  new URL("../apps/dashboard/components/thread/photo-viewer.tsx", import.meta.url),
  "utf8"
);
const playable = readFileSync(
  new URL("../apps/dashboard/components/thread/playable-media.tsx", import.meta.url),
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
const google = readFileSync(
  new URL("../apps/dashboard/components/thread/google-messages-media.tsx", import.meta.url),
  "utf8"
);

test("failed-media card shows type, filename slot, failed state, Retry, and Open", () => {
  assert.match(fallback, /kindLabel/);
  assert.match(fallback, /filename/);
  assert.match(fallback, /Could not load this attachment/);
  assert.match(fallback, />\s*Retry\s*</);
  assert.match(fallback, />\s*Open\s*</);
  assert.match(fallback, /role="status"/);
  // UI copy must not use em/en dashes.
  assert.doesNotMatch(fallback, /[—–]/);
});

test("PhotoViewer uses phone-safe rewrite and surfaces MediaFallbackCard on error", () => {
  assert.match(photoViewer, /rewriteLocalMediaUrl/);
  assert.match(photoViewer, /withMediaRetryParam/);
  assert.match(photoViewer, /MediaFallbackCard/);
  assert.match(photoViewer, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(photoViewer, /setAttempt/);
});

test("PlayableMedia covers video and audio with the same fallback", () => {
  assert.match(playable, /as: "video" \| "audio"/);
  assert.match(playable, /MediaFallbackCard/);
  assert.match(playable, /rewriteLocalMediaUrl/);
  assert.match(playable, /onError=\{\(\) => setFailed\(true\)\}/);
});

test("thread media waits for a user tap before requesting large or missing files", () => {
  assert.doesNotMatch(playable, /preload="metadata"/);
  assert.equal((playable.match(/preload="none"/g) ?? []).length, 2);
});

test("platform media components build attachment paths via attachmentMediaPath", () => {
  for (const source of [imessage, whatsapp, google]) {
    assert.match(source, /attachmentMediaPath/);
    assert.match(source, /rewriteLocalMediaUrl/);
  }
  assert.match(imessage, /PlayableMedia/);
  assert.match(whatsapp, /PlayableMedia/);
  assert.match(google, /PlayableMedia/);
  // No raw localhost embedding in media URL construction.
  assert.doesNotMatch(imessage, /http:\/\/localhost/);
  assert.doesNotMatch(whatsapp, /http:\/\/localhost/);
  assert.doesNotMatch(google, /http:\/\/localhost/);
});

test("message photos still use the in-app viewer instead of blank image windows", () => {
  assert.match(imessage, /<PhotoViewer/);
  assert.match(whatsapp, /<PhotoViewer/);
  assert.match(photoViewer, />\s*Close\s*</);
  assert.match(photoViewer, /event\.key === "Escape"/);
});
