import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  clearLinkPreviewCache,
  getLinkPreview
} from "../apps/runner/dist/services/link-preview.js";

// End-to-end behaviour of getLinkPreview against a local fixture server.
// The fixture lives on 127.0.0.1, which the SSRF guard rightly refuses, so
// these tests pass `allowPrivateTargets: true` (a test-only escape hatch) -
// and one test pins that WITHOUT the flag the same URL is refused.

const OG_PAGE = `<!doctype html><html><head>
  <meta property="og:title" content="Fixture Title">
  <meta property="og:description" content="Fixture description">
  <meta property="og:image" content="/thumb.jpg">
  <meta property="og:site_name" content="Fixture Site">
</head><body>hello</body></html>`;

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(OG_PAGE);
    } else if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else if (url.pathname === "/relative-redirect") {
      res.writeHead(301, { location: "ok" });
      res.end();
    } else if (url.pathname === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (url.pathname === "/huge") {
      // og:title sits past the 512KB read cap - the parse must miss it
      // without hanging or buffering the whole body.
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head>");
      res.write("x".repeat(600 * 1024));
      res.end(`<meta property="og:title" content="Too Deep"></head></html>`);
    } else if (url.pathname === "/framed") {
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
      res.end(OG_PAGE);
    } else if (url.pathname === "/csp") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "frame-ancestors 'self'"
      });
      res.end(OG_PAGE);
    } else if (url.pathname === "/plain") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    } else if (url.pathname === "/missing") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><head></head><body>nope</body></html>");
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test("getLinkPreview: fixture server behaviours", async (t) => {
  const { server, origin } = await startFixtureServer();
  t.after(() => server.close());
  const opts = { allowPrivateTargets: true };

  await t.test("parses Open Graph fields and resolves the relative image", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/ok`, opts);
    assert.equal(preview.status, "ok");
    assert.equal(preview.title, "Fixture Title");
    assert.equal(preview.description, "Fixture description");
    assert.equal(preview.imageUrl, `${origin}/thumb.jpg`);
    assert.equal(preview.siteName, "Fixture Site");
    assert.equal(preview.embeddable, true);
    assert.equal(preview.provider, null);
    assert.equal(preview.host, "127.0.0.1");
  });

  await t.test("follows redirects (absolute and relative) to the final URL", async () => {
    clearLinkPreviewCache();
    const absolute = await getLinkPreview(`${origin}/redirect`, opts);
    assert.equal(absolute.status, "ok");
    assert.equal(absolute.finalUrl, `${origin}/ok`);
    assert.equal(absolute.title, "Fixture Title");

    const relative = await getLinkPreview(`${origin}/relative-redirect`, opts);
    assert.equal(relative.finalUrl, `${origin}/ok`);
  });

  await t.test("redirect loops degrade to an error preview, not a hang", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/loop`, opts);
    assert.equal(preview.status, "error");
  });

  await t.test("bodies are read capped - oversized pages return without the deep title", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/huge`, opts);
    assert.equal(preview.status, "ok");
    assert.equal(preview.title, null);
  });

  await t.test("X-Frame-Options and CSP frame-ancestors mark pages non-embeddable", async () => {
    clearLinkPreviewCache();
    const xfo = await getLinkPreview(`${origin}/framed`, opts);
    assert.equal(xfo.status, "ok");
    assert.equal(xfo.embeddable, false);
    const csp = await getLinkPreview(`${origin}/csp`, opts);
    assert.equal(csp.embeddable, false);
  });

  await t.test("non-HTML responses come back ok with no metadata", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/plain`, opts);
    assert.equal(preview.status, "ok");
    assert.equal(preview.title, null);
    assert.equal(preview.imageUrl, null);
  });

  await t.test("HTTP error pages without metadata are error previews", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/missing`, opts);
    assert.equal(preview.status, "error");
    assert.equal(preview.embeddable, false);
  });

  await t.test("results are cached per URL", async () => {
    clearLinkPreviewCache();
    const first = await getLinkPreview(`${origin}/ok`, opts);
    const again = await getLinkPreview(`${origin}/ok`, opts);
    assert.equal(again, first);
  });

  await t.test("without the test flag, the loopback fixture is refused by the guard", async () => {
    clearLinkPreviewCache();
    const preview = await getLinkPreview(`${origin}/ok`);
    assert.equal(preview.status, "error");
    assert.equal(preview.title, null);
  });
});

test("getLinkPreview: unparseable input returns an error preview without fetching", async () => {
  clearLinkPreviewCache();
  const preview = await getLinkPreview("not a url");
  assert.equal(preview.status, "error");
  assert.equal(preview.url, "not a url");
});

test("getLinkPreview: TikTok short links resolve via redirect + oEmbed rescue", async () => {
  clearLinkPreviewCache();
  // Simulates the real flow for https://vm.tiktok.com/XYZ/: a redirect to
  // the canonical video URL, a bot-walled watch page, and a healthy
  // oEmbed endpoint. DNS is stubbed to a public address so the guard
  // passes without network access.
  const videoUrl = "https://www.tiktok.com/@watavibes/video/7345678901234567890";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith("https://vm.tiktok.com/")) {
      return new Response(null, { status: 302, headers: { location: videoUrl } });
    }
    if (url.startsWith("https://www.tiktok.com/oembed")) {
      return new Response(
        JSON.stringify({
          title: "THE WAVY FDLM WEEKEND - Paris",
          author_name: "ONLY WATA VIBES",
          thumbnail_url: "https://p16-sign.tiktokcdn.com/thumb.jpg",
          embed_product_id: "7345678901234567890"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.startsWith("https://www.tiktok.com/@watavibes/video/")) {
      return new Response("<html><head><title>tiktok</title></head></html>", {
        status: 403,
        headers: { "content-type": "text/html" }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const preview = await getLinkPreview("https://vm.tiktok.com/ZNR7vj6fP/", {
    fetchImpl,
    resolveAddresses: async () => ["93.184.216.34"]
  });
  assert.equal(preview.status, "ok");
  assert.equal(preview.provider, "tiktok");
  assert.equal(preview.finalUrl, videoUrl);
  assert.equal(preview.title, "THE WAVY FDLM WEEKEND - Paris");
  assert.equal(preview.description, "ONLY WATA VIBES");
  assert.equal(preview.imageUrl, "https://p16-sign.tiktokcdn.com/thumb.jpg");
  assert.equal(preview.embedUrl, "https://www.tiktok.com/embed/v2/7345678901234567890");
  assert.equal(preview.siteName, "TikTok");
  // The page itself 403'd, so it must not be offered to an iframe.
  assert.equal(preview.embeddable, false);
});

test("getLinkPreview: oEmbed retries with the original short link when the final URL is refused", async () => {
  clearLinkPreviewCache();
  // A short link whose redirect detours to an interstitial: oEmbed on the
  // interstitial 400s, but oEmbed accepts the short link itself.
  const shortUrl = "https://vm.tiktok.com/SHORT2/";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === shortUrl) {
      return new Response(null, { status: 302, headers: { location: "https://www.tiktok.com/foryou" } });
    }
    if (url.startsWith("https://www.tiktok.com/oembed")) {
      const asked = new URL(url).searchParams.get("url");
      if (asked === shortUrl) {
        return new Response(
          JSON.stringify({
            title: "Rescued via the short link",
            author_name: "someone",
            thumbnail_url: "https://p16-sign.tiktokcdn.com/t.jpg",
            embed_product_id: "7000000000000000001"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "Something went wrong", code: 400 }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === "https://www.tiktok.com/foryou") {
      return new Response("<html><head><title>TikTok - Make Your Day</title></head></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const preview = await getLinkPreview(shortUrl, {
    fetchImpl,
    resolveAddresses: async () => ["93.184.216.34"]
  });
  assert.equal(preview.status, "ok");
  assert.equal(preview.title, "Rescued via the short link");
  assert.equal(preview.embedUrl, "https://www.tiktok.com/embed/v2/7000000000000000001");
});

test("getLinkPreview: TikTok's generic SPA title is suppressed (photo posts)", async () => {
  clearLinkPreviewCache();
  // Photo posts: no v2 player, oEmbed refuses them, and the page serves
  // the SPA shell whose <title> is the homepage's. The card must degrade
  // to siteName + host instead of claiming "Make Your Day".
  const photoUrl = "https://www.tiktok.com/@watavibes/photo/7647223235964046625";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith("https://www.tiktok.com/oembed")) {
      return new Response(JSON.stringify({ message: "Something went wrong", code: 400 }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.startsWith("https://www.tiktok.com/@watavibes/photo/")) {
      return new Response("<html><head><title>TikTok - Make Your Day</title></head></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const preview = await getLinkPreview(photoUrl, {
    fetchImpl,
    resolveAddresses: async () => ["93.184.216.34"]
  });
  assert.equal(preview.status, "ok");
  assert.equal(preview.provider, "tiktok");
  assert.equal(preview.title, null);
  assert.equal(preview.siteName, "TikTok");
  assert.equal(preview.embedUrl, null);
});
