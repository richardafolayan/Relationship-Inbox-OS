import test from "node:test";
import assert from "node:assert/strict";

// linkify.ts is framework-free, so the tsx loader resolves this .ts import
// directly (same pattern as dashboard-clean-ask-summary.test.mjs).
const { splitTextSegments, extractUrls, urlOnlyMessage, displayHost } = await import(
  "../apps/dashboard/lib/linkify.ts"
);

test("splitTextSegments: text without URLs is a single text segment", () => {
  assert.deepEqual(splitTextSegments("can i call?"), [{ type: "text", value: "can i call?" }]);
  assert.deepEqual(splitTextSegments(""), [{ type: "text", value: "" }]);
  // Bare domains without a scheme or www. stay plain text on purpose.
  assert.deepEqual(splitTextSegments("check tiktok.com later"), [
    { type: "text", value: "check tiktok.com later" }
  ]);
});

test("splitTextSegments: detects https URLs mid-sentence", () => {
  assert.deepEqual(splitTextSegments("look at https://vm.tiktok.com/ZNR7vj6fP/ now"), [
    { type: "text", value: "look at " },
    { type: "url", value: "https://vm.tiktok.com/ZNR7vj6fP/", href: "https://vm.tiktok.com/ZNR7vj6fP/" },
    { type: "text", value: " now" }
  ]);
});

test("splitTextSegments: www. links get an https href", () => {
  assert.deepEqual(splitTextSegments("www.example.com/page is good"), [
    { type: "url", value: "www.example.com/page", href: "https://www.example.com/page" },
    { type: "text", value: " is good" }
  ]);
});

test("splitTextSegments: trailing sentence punctuation stays out of the link", () => {
  for (const [text, expectedUrl] of [
    ["see https://example.com/a.", "https://example.com/a"],
    ["see https://example.com/a, then b", "https://example.com/a"],
    ["really? https://example.com/a!", "https://example.com/a"],
    ["(see https://example.com/a)", "https://example.com/a"],
    ['quote "https://example.com/a"', "https://example.com/a"]
  ]) {
    const urls = extractUrls(text);
    assert.deepEqual(urls, [expectedUrl], text);
  }
});

test("splitTextSegments: balanced closing parens stay in the link", () => {
  assert.deepEqual(extractUrls("https://en.wikipedia.org/wiki/Bracket_(disambiguation)"), [
    "https://en.wikipedia.org/wiki/Bracket_(disambiguation)"
  ]);
});

test("splitTextSegments: multiple URLs keep their order", () => {
  const text = "first https://a.example.com then www.b.example.com done";
  assert.deepEqual(extractUrls(text), ["https://a.example.com", "https://www.b.example.com"]);
});

test("splitTextSegments: uppercase scheme is recognised", () => {
  assert.deepEqual(extractUrls("HTTPS://EXAMPLE.COM/A"), ["HTTPS://EXAMPLE.COM/A"]);
});

test("splitTextSegments: degenerate candidates are ignored", () => {
  assert.deepEqual(extractUrls("https:// and www. alone"), []);
});

test("urlOnlyMessage: a message that is exactly one URL returns its href", () => {
  assert.equal(urlOnlyMessage("https://vm.tiktok.com/ZNRv28UkE/"), "https://vm.tiktok.com/ZNRv28UkE/");
  assert.equal(urlOnlyMessage("  https://vm.tiktok.com/ZNRv28UkE/  "), "https://vm.tiktok.com/ZNRv28UkE/");
  assert.equal(urlOnlyMessage("www.example.com/x"), "https://www.example.com/x");
});

test("urlOnlyMessage: anything else returns null", () => {
  assert.equal(urlOnlyMessage("watch this https://vm.tiktok.com/ZNRv28UkE/"), null);
  assert.equal(urlOnlyMessage("https://a.example.com https://b.example.com"), null);
  assert.equal(urlOnlyMessage("no links here"), null);
  assert.equal(urlOnlyMessage(""), null);
});

test("displayHost: strips www and survives junk", () => {
  assert.equal(displayHost("https://www.tiktok.com/@x/video/1"), "tiktok.com");
  assert.equal(displayHost("https://vm.tiktok.com/Z/"), "vm.tiktok.com");
  assert.equal(displayHost("not a url"), "not a url");
});
