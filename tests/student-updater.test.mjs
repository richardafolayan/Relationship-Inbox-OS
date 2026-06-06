import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER = join(ROOT, "scripts", "update-student.mjs");

// Spawn the updater async so this process's HTTP server keeps serving while
// the child fetches from it (execFileSync would deadlock the event loop).
function runUpdater(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPDATER, ...args]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("student updater: check, apply+preserve, rollback-on-bad-checksum", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "rios-updater-test-"));
  const appDir = join(work, "RelationshipInboxOS");

  // A pretend installed app at 0.1.0 with personal data to protect.
  mkdirSync(join(appDir, "data"), { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
  writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(appDir, ".env"), "OPENAI_API_KEY=KEEP_ME\n");
  writeFileSync(join(appDir, "data", "inbox-os.sqlite"), "USER_DATA");

  // A pretend new release (0.2.0) packaged as the updater expects.
  const stage = join(work, "stage");
  const inner = join(stage, "relationship-inbox-os");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.2.0" }));
  writeFileSync(join(inner, "NEWCODE.txt"), "v0.2.0");
  writeFileSync(join(inner, ".env.example"), "OPENAI_API_KEY=\n");
  const zipPath = join(work, "app.zip");
  execFileSync("zip", ["-r", "-q", zipPath, "relationship-inbox-os"], { cwd: stage });
  const zipBuf = readFileSync(zipPath);
  const sha = createHash("sha256").update(zipBuf).digest("hex");

  const manifest = (zipUrl, sha256 = sha, version = "0.2.0") =>
    JSON.stringify({
      version, build: "2026-06-06T00:00:00Z", commit: "deadbee",
      zipUrl, sha256, releaseNotes: ["New stuff"], minimumInstallerVersion: "0.1.0"
    });

  let PORT;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { Location: `http://localhost:${PORT}/latest.json` });
      return res.end();
    }
    if (req.url.startsWith("/latest.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/app.zip`));
    }
    if (req.url.startsWith("/bad-checksum.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/app.zip`, "f".repeat(64)));
    }
    if (req.url.startsWith("/same-version.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/app.zip`, sha, "0.1.0"));
    }
    if (req.url.startsWith("/app.zip")) {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(zipBuf);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  PORT = server.address().port;
  const url = (p) => `http://localhost:${PORT}${p}`;

  try {
    await t.test("check-only reports an available update (following a redirect)", async () => {
      const { code, stdout } = await runUpdater([
        "--check-only", "--json", "--dir", appDir, "--url", url("/redirect")
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.updateAvailable, true);
      assert.equal(parsed.latestVersion, "0.2.0");
    });

    await t.test("apply swaps in new code and preserves .env + data/", async () => {
      const { code } = await runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/latest.json")
      ]);
      assert.equal(code, 0);
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.2.0");
      assert.ok(existsSync(join(appDir, "NEWCODE.txt")), "new code missing");
      assert.match(readFileSync(join(appDir, ".env"), "utf8"), /KEEP_ME/);
      assert.equal(readFileSync(join(appDir, "data", "inbox-os.sqlite"), "utf8"), "USER_DATA");
      assert.ok(readdirSync(work).some((n) => n.startsWith(".rios-backup-")), "no backup was made");
    });

    await t.test("a bad checksum aborts and leaves the install untouched", async () => {
      // Reset to a clean 0.1.0 install.
      rmSync(appDir, { recursive: true, force: true });
      mkdirSync(join(appDir, "data"), { recursive: true });
      writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
      writeFileSync(join(appDir, ".env"), "OPENAI_API_KEY=KEEP_ME\n");
      writeFileSync(join(appDir, "data", "inbox-os.sqlite"), "USER_DATA");

      const { code } = await runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/bad-checksum.json")
      ]);
      assert.notEqual(code, 0, "updater should exit non-zero on checksum mismatch");
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.1.0");
      assert.ok(!existsSync(join(appDir, "NEWCODE.txt")), "install was modified despite a bad checksum");
      assert.match(readFileSync(join(appDir, ".env"), "utf8"), /KEEP_ME/);
    });

    await t.test("an equal version is a no-op (nothing to apply)", async () => {
      const before = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      const { code, stdout } = await runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/same-version.json")
      ]);
      assert.equal(code, 0);
      assert.match(stdout, /up to date|Nothing to do/i);
      const after = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      assert.equal(after, before, "a no-op update should not create a backup");
    });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(work, { recursive: true, force: true });
  }
});
