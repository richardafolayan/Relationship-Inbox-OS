import test from "node:test";
import assert from "node:assert/strict";
import {
  detectEmbeddable,
  parseOpenGraph,
  resolveProvider
} from "../apps/runner/dist/services/link-preview.js";

const BASE = "https://example.com/post/1";

test("parseOpenGraph: standard og tags in either attribute order", () => {
  const html = `
    <html><head>
      <meta property="og:title" content="A Story" />
      <meta content="What happened next" property="og:description">
      <meta property="og:image" content="https://cdn.example.com/pic.jpg"/>
      <meta property="og:site_name" content="Example News">
      <title>fallback title</title>
    </head><body></body></html>`;
  assert.deepEqual(parseOpenGraph(html, BASE), {
    title: "A Story",
    description: "What happened next",
    imageUrl: "https://cdn.example.com/pic.jpg",
    siteName: "Example News"
  });
});

test("parseOpenGraph: single quotes and unquoted values parse", () => {
  const html = `<meta property='og:title' content='Quoted "inner" title'>` +
    `<meta property=og:site_name content=Example>`;
  const parsed = parseOpenGraph(html, BASE);
  assert.equal(parsed.title, 'Quoted "inner" title');
  assert.equal(parsed.siteName, "Example");
});

test("parseOpenGraph: falls back to twitter tags, then the title tag", () => {
  const twitter = parseOpenGraph(
    `<meta name="twitter:title" content="Tweet card"><meta name="twitter:image" content="/img.png">`,
    BASE
  );
  assert.equal(twitter.title, "Tweet card");
  assert.equal(twitter.imageUrl, "https://example.com/img.png");

  const titleOnly = parseOpenGraph(`<head><title> Plain page </title></head>`, BASE);
  assert.equal(titleOnly.title, "Plain page");
  assert.equal(titleOnly.imageUrl, null);
});

test("parseOpenGraph: HTML entities are decoded", () => {
  const html = `<meta property="og:title" content="Fish &amp; Chips &#x2764; &#8217;s &quot;best&quot;">`;
  assert.equal(parseOpenGraph(html, BASE).title, `Fish & Chips ❤ ’s "best"`);
});

test("parseOpenGraph: relative image URLs resolve against the page URL", () => {
  const html = `<meta property="og:image" content="../assets/pic.jpg">`;
  assert.equal(parseOpenGraph(html, "https://example.com/a/b/c").imageUrl, "https://example.com/a/assets/pic.jpg");
});

test("parseOpenGraph: non-http image schemes are dropped", () => {
  const html = `<meta property="og:image" content="javascript:alert(1)">`;
  assert.equal(parseOpenGraph(html, BASE).imageUrl, null);
});

test("parseOpenGraph: whitespace collapses and long fields are capped", () => {
  const longTitle = "word ".repeat(200);
  const html = `<meta property="og:title" content="  ${longTitle}  ">` +
    `<meta property="og:description" content="line\n   break">`;
  const parsed = parseOpenGraph(html, BASE);
  assert.ok(parsed.title.length <= 400);
  assert.ok(parsed.title.endsWith("..."));
  assert.equal(parsed.description, "line break");
});

test("parseOpenGraph: empty page yields all nulls", () => {
  assert.deepEqual(parseOpenGraph("<html></html>", BASE), {
    title: null,
    description: null,
    imageUrl: null,
    siteName: null
  });
});

function headersOf(record) {
  const map = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

test("detectEmbeddable: no framing headers means embeddable", () => {
  assert.equal(detectEmbeddable(headersOf({})), true);
  assert.equal(detectEmbeddable(headersOf({ "content-security-policy": "default-src 'self'" })), true);
});

test("detectEmbeddable: any X-Frame-Options blocks", () => {
  assert.equal(detectEmbeddable(headersOf({ "x-frame-options": "DENY" })), false);
  assert.equal(detectEmbeddable(headersOf({ "x-frame-options": "SAMEORIGIN" })), false);
  assert.equal(detectEmbeddable(headersOf({ "X-Frame-Options": "ALLOW-FROM x" })), false);
});

test("detectEmbeddable: CSP frame-ancestors blocks unless wildcard-open", () => {
  assert.equal(
    detectEmbeddable(headersOf({ "content-security-policy": "frame-ancestors 'none'" })),
    false
  );
  assert.equal(
    detectEmbeddable(headersOf({ "content-security-policy": "frame-ancestors 'self' https://a.com" })),
    false
  );
  assert.equal(
    detectEmbeddable(headersOf({ "content-security-policy": "default-src *; frame-ancestors *" })),
    true
  );
  assert.equal(
    detectEmbeddable(headersOf({ "content-security-policy": "frame-ancestors https:" })),
    true
  );
});

test("resolveProvider: tiktok video URLs map to the v2 embed player", () => {
  const video = resolveProvider(new URL("https://www.tiktok.com/@somebody/video/7345678901234567890"));
  assert.equal(video.provider, "tiktok");
  assert.equal(video.embedUrl, "https://www.tiktok.com/embed/v2/7345678901234567890");

  // Short links have no video id until the redirect resolves - provider
  // is known, the player is not.
  const short = resolveProvider(new URL("https://vm.tiktok.com/ZNR7vj6fP/"));
  assert.equal(short.provider, "tiktok");
  assert.equal(short.embedUrl, null);

  // Photo posts have no v2 player.
  const photo = resolveProvider(new URL("https://www.tiktok.com/@x/photo/7345678901234567890"));
  assert.equal(photo.provider, "tiktok");
  assert.equal(photo.embedUrl, null);
});

test("resolveProvider: youtube URL shapes map to the nocookie embed", () => {
  const expected = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  assert.equal(resolveProvider(new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).embedUrl, expected);
  assert.equal(resolveProvider(new URL("https://youtu.be/dQw4w9WgXcQ?t=10")).embedUrl, expected);
  assert.equal(resolveProvider(new URL("https://www.youtube.com/shorts/dQw4w9WgXcQ")).embedUrl, expected);
  assert.equal(resolveProvider(new URL("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).embedUrl, expected);
});

test("resolveProvider: malformed ids do not produce embed URLs", () => {
  const weird = resolveProvider(new URL('https://www.youtube.com/watch?v=<script>"'));
  assert.equal(weird.provider, "youtube");
  assert.equal(weird.embedUrl, null);
  const tiktokWeird = resolveProvider(new URL("https://www.tiktok.com/@x/video/notdigits"));
  assert.equal(tiktokWeird.embedUrl, null);
});

test("resolveProvider: unrelated hosts return null", () => {
  assert.equal(resolveProvider(new URL("https://example.com/watch?v=abc12345")), null);
  assert.equal(resolveProvider(new URL("https://nottiktok.com/video/123456")), null);
  assert.equal(resolveProvider(new URL("https://faketiktok.com.evil.com/video/1234567")), null);
});
