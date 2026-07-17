import assert from "node:assert/strict";
import test from "node:test";

const {
  attachmentMediaPath,
  isLocalOnlyHostname,
  mediaKindLabel,
  normalizeRunnerMediaPath,
  rewriteLocalMediaUrl,
  withMediaRetryParam
} = await import("../apps/dashboard/lib/media-url.ts");

test("local-only hostnames cover loopback and Bonjour forms", () => {
  assert.equal(isLocalOnlyHostname("localhost"), true);
  assert.equal(isLocalOnlyHostname("LOCALHOST"), true);
  assert.equal(isLocalOnlyHostname("127.0.0.1"), true);
  assert.equal(isLocalOnlyHostname("0.0.0.0"), true);
  assert.equal(isLocalOnlyHostname("::1"), true);
  assert.equal(isLocalOnlyHostname("[::1]"), true);
  assert.equal(isLocalOnlyHostname("richards-macbook.local"), true);
  assert.equal(isLocalOnlyHostname("foo.localhost"), true);
  assert.equal(isLocalOnlyHostname("192.168.1.4"), false);
  assert.equal(isLocalOnlyHostname("media.cdn.example"), false);
  assert.equal(isLocalOnlyHostname(""), false);
});

test("normalizeRunnerMediaPath prefixes bare /data routes for the dashboard rewrite", () => {
  assert.equal(
    normalizeRunnerMediaPath("/data/imessage-attachment/abc"),
    "/runner/data/imessage-attachment/abc"
  );
  assert.equal(
    normalizeRunnerMediaPath("/data/whatsapp-attachment/x?y=1"),
    "/runner/data/whatsapp-attachment/x?y=1"
  );
  assert.equal(
    normalizeRunnerMediaPath("/runner/data/imessage-attachment/abc"),
    "/runner/data/imessage-attachment/abc"
  );
  assert.equal(normalizeRunnerMediaPath("/events"), "/events");
});

test("rewriteLocalMediaUrl collapses localhost absolute URLs to same-origin paths", () => {
  assert.equal(
    rewriteLocalMediaUrl("http://localhost:4001/data/imessage-attachment/guid-1"),
    "/runner/data/imessage-attachment/guid-1"
  );
  assert.equal(
    rewriteLocalMediaUrl("http://127.0.0.1:4001/data/whatsapp-attachment/wa-1"),
    "/runner/data/whatsapp-attachment/wa-1"
  );
  assert.equal(
    rewriteLocalMediaUrl("http://localhost:3000/runner/data/imessage-attachment/g"),
    "/runner/data/imessage-attachment/g"
  );
  assert.equal(
    rewriteLocalMediaUrl("http://richards-macbook.local:3000/runner/data/imessage-attachment/g"),
    "/runner/data/imessage-attachment/g"
  );
  assert.equal(
    rewriteLocalMediaUrl("//localhost:4001/data/imessage-attachment/g"),
    "/runner/data/imessage-attachment/g"
  );
});

test("rewriteLocalMediaUrl keeps already-safe relative paths", () => {
  assert.equal(
    rewriteLocalMediaUrl("/runner/data/imessage-attachment/g"),
    "/runner/data/imessage-attachment/g"
  );
  assert.equal(
    rewriteLocalMediaUrl("/data/imessage-attachment/g"),
    "/runner/data/imessage-attachment/g"
  );
});

test("rewriteLocalMediaUrl leaves non-local remote URLs alone", () => {
  const remote = "https://media.licdn.com/dms/image/v2/C4E03AQ/profile-displayphoto";
  assert.equal(rewriteLocalMediaUrl(remote), remote);
  assert.equal(
    rewriteLocalMediaUrl("https://example.com/photo.jpg"),
    "https://example.com/photo.jpg"
  );
});

test("rewriteLocalMediaUrl rejects file:// paths that phones cannot load", () => {
  assert.equal(rewriteLocalMediaUrl("file:///Users/me/Library/Messages/Attachments/a.jpg"), "");
  assert.equal(rewriteLocalMediaUrl(""), "");
});

test("attachmentMediaPath always builds phone-safe relative runner paths", () => {
  assert.equal(
    attachmentMediaPath({ guid: "3C3CA15E-7C18-4A1B-9F2D-0123456789AB" }),
    "/runner/data/imessage-attachment/3C3CA15E-7C18-4A1B-9F2D-0123456789AB"
  );
  assert.equal(
    attachmentMediaPath({ guid: "wa-media-1", platform: "whatsapp" }),
    "/runner/data/whatsapp-attachment/wa-media-1"
  );
  assert.equal(
    attachmentMediaPath({ guid: "abc.def", platform: "google_messages" }),
    "/runner/data/google-messages-attachment/abc.def"
  );
  assert.equal(
    attachmentMediaPath({
      guid: "li-msg-fp:IN|Name|Hi",
      isLinkedInVoice: true
    }),
    `/runner/data/linkedin-voice-message/${encodeURIComponent("li-msg-fp:IN|Name|Hi")}`
  );
  // Guids with reserved characters stay encoded.
  assert.equal(
    attachmentMediaPath({ guid: "a/b?c", platform: "imessage" }),
    "/runner/data/imessage-attachment/a%2Fb%3Fc"
  );
});

test("withMediaRetryParam cache-busts without clobbering existing query or hash", () => {
  assert.equal(withMediaRetryParam("/runner/data/x", 0), "/runner/data/x");
  assert.equal(withMediaRetryParam("/runner/data/x", 1), "/runner/data/x?_retry=1");
  assert.equal(withMediaRetryParam("/runner/data/x?a=1", 2), "/runner/data/x?a=1&_retry=2");
  assert.equal(withMediaRetryParam("/runner/data/x#frag", 1), "/runner/data/x?_retry=1#frag");
});

test("mediaKindLabel covers known attachment kinds", () => {
  assert.equal(mediaKindLabel("photo"), "Photo");
  assert.equal(mediaKindLabel("voice_note"), "Voice note");
  assert.equal(mediaKindLabel("gif"), "GIF");
  assert.equal(mediaKindLabel("unknown"), "Attachment");
  assert.equal(mediaKindLabel(null), "Attachment");
});

test("rewritten attachment URLs never embed localhost for phone clients", () => {
  const cases = [
    "http://localhost:4001/data/imessage-attachment/g1",
    "http://127.0.0.1:4001/data/whatsapp-attachment/g2",
    "http://localhost:3000/runner/data/google-messages-attachment/g3",
    "/runner/data/imessage-attachment/g4",
    attachmentMediaPath({ guid: "g5", platform: "whatsapp" })
  ];
  for (const input of cases) {
    const out = rewriteLocalMediaUrl(input, "http://100.64.1.2:3110");
    assert.equal(out.includes("localhost"), false, `still has localhost: ${out}`);
    assert.equal(out.includes("127.0.0.1"), false, `still has 127.0.0.1: ${out}`);
    assert.ok(out.startsWith("/runner/data/"), `not a stable media path: ${out}`);
  }
});
