import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = join(ROOT, "scripts", "publish-student-release.mjs");
const BUILD = join(ROOT, "scripts", "build-student-release.mjs");
const LATEST_ZIP = join(ROOT, "release-dist", "relationship-inbox-os-student-latest.zip");

// Isolate every spawned publish from a real .env.release.local a developer may
// have on disk (it would otherwise inject config the tests deliberately omit).
process.env.RIOS_RELEASE_ENV_FILE = "/nonexistent/.env.release.local";

// Spawn publish async so this process's mock-Dropbox HTTP server keeps serving
// while the child uploads + verifies (execFileSync would deadlock).
function runPublish(extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUBLISH, "--skip-build", ...extraArgs], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A mock Dropbox: accepts /oauth2/token + /2/files/upload, then serves the
// uploaded bytes back at the public share URLs.
function makeMockDropbox(opts = {}) {
  const store = new Map(); // dropbox path -> Buffer
  const uploads = []; // { path, mode }
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (url === "/oauth2/token") {
        if (opts.tokenStatus) { res.writeHead(opts.tokenStatus); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "mock-access", expires_in: 14400 }));
      }
      if (url === "/2/files/upload") {
        const arg = JSON.parse(req.headers["dropbox-api-arg"] || "{}");
        uploads.push({ path: arg.path, mode: arg.mode });
        if (opts.uploadStatus) { res.writeHead(opts.uploadStatus); return res.end("rate limited"); }
        store.set(arg.path, body);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ name: arg.path.split("/").pop(), id: "id:mock", path_lower: arg.path.toLowerCase() }));
      }
      if (url === "/2/sharing/create_shared_link_with_settings") {
        const { path } = JSON.parse(body.toString() || "{}");
        // st= deliberately FIRST, to prove the script strips it regardless of
        // query-param order (a plain regex would mangle a first-position param).
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ url: `http://${req.headers.host}/scl${path}?st=ephemeral&rlkey=abc&dl=0`, ".tag": "file" }));
      }
      if (url === "/share/manifest") {
        if (opts.manifestHtml) {
          res.writeHead(200, { "content-type": "text/html" });
          return res.end("<!doctype html><html><body>Dropbox</body></html>");
        }
        if (opts.staleVersion) {
          // Serve a manifest whose version differs from what was uploaded (a
          // stale/cached feed) to prove the verify step catches it.
          const m = JSON.parse((store.get(opts.manifestPath) || Buffer.from("{}")).toString());
          m.version = "9.9.9";
          return serve(res, Buffer.from(JSON.stringify(m)), "application/json");
        }
        return serve(res, store.get(opts.manifestPath), "application/json");
      }
      if (url === "/share/zip") {
        if (opts.corruptZip) return serve(res, Buffer.from("CORRUPTED"), "application/zip");
        return serve(res, store.get(opts.zipPath), "application/zip");
      }
      res.writeHead(404); res.end();
    });
  });
  function serve(res, buf, type) {
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  }
  return { server, store, uploads };
}

function baseEnv(port, opts = {}) {
  return {
    RIOS_DROPBOX_API_BASE: `http://localhost:${port}`,
    RIOS_DROPBOX_CONTENT_BASE: `http://localhost:${port}`,
    RIOS_DROPBOX_ZIP_PATH: opts.zipPath,
    RIOS_DROPBOX_MANIFEST_PATH: opts.manifestPath,
    RIOS_DROPBOX_ZIP_URL: `http://localhost:${port}/share/zip`,
    RIOS_UPDATE_FEED_URL: `http://localhost:${port}/share/manifest`,
    DROPBOX_ACCESS_TOKEN: "test-token",
    // Keep the verify-retry loop fast in tests (no real propagation lag here).
    RIOS_PUBLISH_VERIFY_RETRIES: "2",
    RIOS_PUBLISH_VERIFY_DELAY_MS: "0",
  };
}

test("publish-student-release: build once, then publish flows", async (t) => {
  // Build the release once; subtests reuse it via --skip-build. Distribution
  // config is set so the build bakes it into the shipped .env.example (the
  // dedicated subtest below asserts that end to end).
  execFileSync(process.execPath, [BUILD], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      RIOS_UPDATE_FEED_URL: "https://feed.example.test/latest.json?rlkey=k&raw=1",
      PILOT_FEEDBACK_WEBHOOK_URL: "https://feedback.example.test/exec",
    },
  });
  assert.ok(existsSync(LATEST_ZIP), "release zip should exist after build");

  await t.test("the shipped .env.example carries the baked distribution config", () => {
    const envExample = execFileSync(
      "unzip", ["-p", LATEST_ZIP, "relationship-inbox-os/.env.example"], { encoding: "utf8" }
    );
    assert.match(
      envExample,
      /^RIOS_UPDATE_FEED_URL=https:\/\/feed\.example\.test\/latest\.json\?rlkey=k&raw=1$/m,
      "update feed link must be baked so updates work out of the box"
    );
    assert.match(
      envExample,
      /^PILOT_FEEDBACK_WEBHOOK_URL=https:\/\/feedback\.example\.test\/exec$/m,
      "feedback webhook must still be baked"
    );
    assert.match(envExample, /^OPENAI_API_KEY=$/m, "no other key gains a value");
  });

  const zipPath = "/pilot/relationship-inbox-os-student-latest.zip";
  const manifestPath = "/pilot/latest.json";

  async function withMock(opts, fn) {
    const mock = makeMockDropbox({ ...opts, zipPath, manifestPath });
    await new Promise((r) => mock.server.listen(0, r));
    const port = mock.server.address().port;
    try {
      return await fn(port, mock);
    } finally {
      await new Promise((r) => mock.server.close(r));
    }
  }

  await t.test("happy path: uploads (overwrite) + verifies the live feed", async () => {
    await withMock({}, async (port, mock) => {
      const { code, stdout } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.equal(code, 0, stdout);
      // Both files uploaded with mode=overwrite (the stable-link property).
      assert.equal(mock.uploads.length, 2);
      assert.ok(mock.uploads.every((u) => u.mode === "overwrite"), "must overwrite, not recreate");
      assert.ok(mock.uploads.some((u) => u.path === zipPath));
      assert.ok(mock.uploads.some((u) => u.path === manifestPath));
      assert.match(stdout, /is live for pilots/);
    });
  });

  await t.test("checksum mismatch (hosted zip tampered) fails loudly", async () => {
    await withMock({ corruptZip: true }, async (port) => {
      const { code, stderr } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.notEqual(code, 0);
      assert.match(stderr, /checksum|sha256/i);
    });
  });

  await t.test("feed serving HTML (dl=0 page) fails loudly", async () => {
    await withMock({ manifestHtml: true }, async (port) => {
      const { code, stderr } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.notEqual(code, 0);
      assert.match(stderr, /web page, not JSON|not JSON/i);
    });
  });

  await t.test("refresh-token flow (no access token) mints a token and succeeds", async () => {
    await withMock({}, async (port) => {
      const env = baseEnv(port, { zipPath, manifestPath });
      delete env.DROPBOX_ACCESS_TOKEN;
      env.DROPBOX_REFRESH_TOKEN = "mock-refresh";
      env.DROPBOX_APP_KEY = "mock-key";
      env.DROPBOX_APP_SECRET = "mock-secret";
      const { code, stdout } = await runPublish([], env);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /is live for pilots/);
    });
  });

  await t.test("missing config fails before any upload", async () => {
    await withMock({}, async (port, mock) => {
      const env = baseEnv(port, { zipPath, manifestPath });
      delete env.RIOS_UPDATE_FEED_URL;
      const { code, stderr } = await runPublish([], env);
      assert.notEqual(code, 0);
      assert.match(stderr, /missing required config/i);
      assert.equal(mock.uploads.length, 0, "must not upload when config is incomplete");
    });
  });

  await t.test("--dry-run uploads nothing", async () => {
    await withMock({}, async (port, mock) => {
      const { code } = await runPublish(["--dry-run"], baseEnv(port, { zipPath, manifestPath }));
      assert.equal(code, 0);
      assert.equal(mock.uploads.length, 0);
    });
  });

  await t.test("--print-links resolves stable links and strips the st= token", async () => {
    await withMock({}, async (port, mock) => {
      const env = {
        RIOS_DROPBOX_API_BASE: `http://localhost:${port}`,
        RIOS_DROPBOX_CONTENT_BASE: `http://localhost:${port}`,
        RIOS_DROPBOX_ZIP_PATH: zipPath,
        RIOS_DROPBOX_MANIFEST_PATH: manifestPath,
        DROPBOX_ACCESS_TOKEN: "test-token",
      };
      const { code, stdout } = await runPublish(["--print-links"], env);
      assert.equal(code, 0, stdout);
      assert.equal(mock.uploads.length, 0, "print-links must not upload");
      const zipLine = stdout.split("\n").find((l) => l.includes("RIOS_DROPBOX_ZIP_URL="));
      const feedLine = stdout.split("\n").find((l) => l.includes("RIOS_UPDATE_FEED_URL="));
      assert.ok(zipLine && /dl=1/.test(zipLine) && !/st=/.test(zipLine), `zip link: ${zipLine}`);
      assert.ok(feedLine && /raw=1/.test(feedLine) && !/st=/.test(feedLine), `feed link: ${feedLine}`);
      assert.ok(/rlkey=/.test(zipLine), "must keep the rlkey access key");
    });
  });

  await t.test("a failed Dropbox upload fails loudly", async () => {
    await withMock({ uploadStatus: 503 }, async (port) => {
      const { code, stderr } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.notEqual(code, 0);
      assert.match(stderr, /upload failed/i);
    });
  });

  await t.test("a failed token refresh fails loudly", async () => {
    await withMock({ tokenStatus: 401 }, async (port) => {
      const env = baseEnv(port, { zipPath, manifestPath });
      delete env.DROPBOX_ACCESS_TOKEN;
      env.DROPBOX_REFRESH_TOKEN = "bad"; env.DROPBOX_APP_KEY = "k"; env.DROPBOX_APP_SECRET = "s";
      const { code, stderr } = await runPublish([], env);
      assert.notEqual(code, 0);
      assert.match(stderr, /token refresh failed/i);
    });
  });

  await t.test("a stale feed (version mismatch) fails verification", async () => {
    await withMock({ staleVersion: true }, async (port) => {
      const { code, stderr } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.notEqual(code, 0);
      assert.match(stderr, /did not verify live|version/i);
    });
  });

  await t.test("runs its own build (no --skip-build) and forwards --notes into the manifest", async () => {
    await withMock({}, async (port, mock) => {
      const child = spawn(process.execPath, [PUBLISH, "--notes", "Test note ABC"], {
        cwd: ROOT,
        env: { ...process.env, ...baseEnv(port, { zipPath, manifestPath }) },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((r) => child.on("close", r));
      assert.equal(code, 0, stderr);
      assert.equal(mock.uploads.length, 2);
      const manifest = JSON.parse(mock.store.get(manifestPath).toString());
      assert.ok(manifest.releaseNotes.includes("Test note ABC"), "release note must reach the manifest");
    });
  });

  await t.test("a zip containing a secret is refused (leak guard) — run last, corrupts the zip", async () => {
    // Inject a forbidden `.env` entry into the built zip and confirm the
    // pre-upload leak scan refuses to publish. (This mutates the shared zip,
    // so it runs last; the next test run rebuilds it.)
    execFileSync("bash", ["-c",
      `cd "${ROOT}/release-dist" && printf 'SECRET=x\\n' > .env && zip -q -m relationship-inbox-os-student-latest.zip .env`]);
    await withMock({}, async (port) => {
      const { code, stderr } = await runPublish([], baseEnv(port, { zipPath, manifestPath }));
      assert.notEqual(code, 0);
      assert.match(stderr, /forbidden files/i);
    });
  });
});
