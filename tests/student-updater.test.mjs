import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireInstallOperation,
  installOperationPath,
  releaseInstallOperation
} from "../scripts/lib/install-maintenance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER = join(ROOT, "scripts", "update-student.mjs");

// Spawn the updater async so this process's HTTP server keeps serving while
// the child fetches from it (execFileSync would deadlock the event loop).
function runUpdater(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [UPDATER, ...args], options);
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
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
    if (req.url.startsWith("/requires-new-installer.json")) {
      const incompatible = JSON.parse(manifest(`http://localhost:${PORT}/app.zip`));
      incompatible.minimumInstallerVersion = "9.9.9";
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(incompatible));
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

    await t.test("an active install operation blocks a concurrent updater before swap", async () => {
      const token = acquireInstallOperation(appDir);
      try {
        const { code, stderr } = await runUpdater([
          "--apply", "--no-deps", "--dir", appDir, "--url", url("/latest.json")
        ]);
        assert.notEqual(code, 0);
        assert.match(stderr, /already changing|another installation/i);
        assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.1.0");
        assert.ok(!existsSync(join(appDir, "NEWCODE.txt")));
      } finally {
        assert.equal(releaseInstallOperation(appDir, token), true);
      }
    });

    await t.test("apply swaps in new code and preserves .env + data/", async () => {
      const runtimeScript = join(appDir, "scripts", "start-app.mjs");
      mkdirSync(join(appDir, "scripts"), { recursive: true });
      writeFileSync(
        runtimeScript,
        `import fs from "node:fs";
         process.on("SIGTERM", () => {
           fs.appendFileSync(${JSON.stringify(join(appDir, "data", "inbox-os.sqlite"))}, "\\nSTOPPED-BEFORE-COPY");
           process.exit(0);
         });
         process.send("ready");
         setInterval(() => {}, 1000);`
      );
      const runtime = spawn(process.execPath, [runtimeScript], {
        cwd: appDir,
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      });
      try {
        await new Promise((resolveReady, reject) => {
          runtime.once("message", resolveReady);
          runtime.once("error", reject);
          runtime.once("exit", (code, signal) => reject(new Error(`runtime exited early (${code ?? signal})`)));
        });
        const { code, stdout, stderr } = await runUpdater([
          "--apply", "--no-deps", "--dir", appDir, "--url", url("/latest.json")
        ]);
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        await waitForExit(runtime);
        assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.2.0");
        assert.ok(existsSync(join(appDir, "NEWCODE.txt")), "new code missing");
        assert.match(readFileSync(join(appDir, ".env"), "utf8"), /KEEP_ME/);
        assert.equal(
          readFileSync(join(appDir, "data", "inbox-os.sqlite"), "utf8"),
          "USER_DATA\nSTOPPED-BEFORE-COPY"
        );
        assert.equal(existsSync(join(appDir, ".tovi-installing")), false, "update lock released");
        assert.equal(existsSync(installOperationPath(appDir)), false, "operation lock released");
        assert.ok(readdirSync(work).some((n) => n.startsWith(".rios-backup-")), "no backup was made");
      } finally {
        if (runtime.pid) {
          try {
            process.kill(runtime.pid, "SIGKILL");
          } catch {}
        }
      }
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

    await t.test("a packaged build failure cannot reach the external database", async () => {
      const fakeBin = join(work, "fake-bin");
      const commandLog = join(work, "packaged-command.log");
      const externalDatabase = join(work, "external.sqlite");
      const appBundle = join(work, "Tovi.app");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(appBundle, { recursive: true });
      writeFileSync(externalDatabase, "USER_DATA");

      const fakeNpm = join(fakeBin, "npm");
      writeFileSync(fakeNpm, `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$TEST_COMMAND_LOG"\nexit 0\n`);
      chmodSync(fakeNpm, 0o755);

      const fakeNode = join(fakeBin, "node");
      writeFileSync(fakeNode, `#!/bin/sh
printf 'node %s\\n' "$*" >> "$TEST_COMMAND_LOG"
case " $* " in
  *" --build-only "*) exit 42 ;;
  *" --database-only "*) printf 'MUTATED' > "$TEST_DATABASE_MARKER" ;;
esac
exit 0
`);
      chmodSync(fakeNode, 0o755);

      const { code } = await runUpdater([
        "--apply", "--dir", appDir, "--url", url("/latest.json"), "--resign", appBundle
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          TEST_COMMAND_LOG: commandLog,
          TEST_DATABASE_MARKER: externalDatabase
        }
      });

      assert.notEqual(code, 0, "a failed packaged build must abort the update");
      assert.equal(readFileSync(externalDatabase, "utf8"), "USER_DATA");
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.1.0");
      assert.deepEqual(readFileSync(commandLog, "utf8").trim().split("\n"), [
        "npm install --include=dev",
        "npm run db:generate",
        "node scripts/start-app.mjs --build-only"
      ]);
    });

    await t.test("an unrecovered database keeps the new code and never claims rollback safety", async () => {
      const fakeBin = join(work, "fake-database-bin");
      const commandLog = join(work, "database-recovery-command.log");
      const appBundle = join(work, "Recovery-Tovi.app");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(appBundle, { recursive: true });

      const fakeNpm = join(fakeBin, "npm");
      writeFileSync(fakeNpm, `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$TEST_COMMAND_LOG"\nexit 0\n`);
      chmodSync(fakeNpm, 0o755);
      const fakeNode = join(fakeBin, "node");
      writeFileSync(fakeNode, `#!/bin/sh
printf 'node %s\\n' "$*" >> "$TEST_COMMAND_LOG"
case " $* " in
  *" --build-only "*)
    mkdir -p packages/core/dist apps/runner/dist apps/dashboard/.next
    : > packages/core/dist/index.js
    : > apps/runner/dist/index.js
    : > apps/dashboard/.next/BUILD_ID
    ;;
  *" --database-only "*) exit 1 ;;
esac
exit 0
`);
      chmodSync(fakeNode, 0o755);

      const { code, stdout, stderr } = await runUpdater([
        "--apply", "--dir", appDir, "--url", url("/latest.json"), "--resign", appBundle
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          TEST_COMMAND_LOG: commandLog
        }
      });

      assert.equal(code, 42);
      assert.match(stderr, /without a verified restoration/i);
      assert.doesNotMatch(`${stdout}\n${stderr}`, /Your data is safe/i);
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.2.0");
      assert.ok(existsSync(join(appDir, "NEWCODE.txt")), "new recovery-capable code must be kept");
      assert.equal(existsSync(join(appDir, ".tovi-installing")), false, "maintenance lock released");
      assert.equal(existsSync(installOperationPath(appDir)), false, "operation lock released");
      assert.deepEqual(readFileSync(commandLog, "utf8").trim().split("\n"), [
        "npm install --include=dev",
        "npm run db:generate",
        "node scripts/start-app.mjs --build-only",
        "node scripts/start-app.mjs --database-only"
      ]);

      rmSync(appDir, { recursive: true, force: true });
      mkdirSync(join(appDir, "data"), { recursive: true });
      writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
      writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(appDir, ".env"), "OPENAI_API_KEY=KEEP_ME\n");
      writeFileSync(join(appDir, "data", "inbox-os.sqlite"), "USER_DATA");
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

    await t.test("an update requiring a newer installer is refused before touching files", async () => {
      const before = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      const { code, stderr } = await runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/requires-new-installer.json")
      ]);
      assert.notEqual(code, 0, "updater should exit non-zero when installer is too old");
      assert.match(stderr, /requires installer 9\.9\.9 or newer/i);
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.1.0");
      assert.ok(!existsSync(join(appDir, "NEWCODE.txt")), "install was modified despite incompatible installer");
      const after = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      assert.equal(after, before, "refused update should not create a backup");
    });

    await t.test("check-only reports an update even when the installer is too old (never dies)", async () => {
      // Regression: enforceMinimumInstallerVersion used to run before report(),
      // so a --check-only against a feed whose minimumInstallerVersion is newer
      // than the install died with a hard error. The in-app "App updates" card
      // runs --check-only, so that made every older install self-block instead
      // of surfacing "update available". check-only must always report.
      const before = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      const { code, stdout, stderr } = await runUpdater([
        "--check-only", "--json", "--dir", appDir, "--url", url("/requires-new-installer.json")
      ]);
      assert.equal(code, 0, `check-only should exit 0, got ${code} (stderr: ${stderr})`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.updateAvailable, true);
      assert.equal(parsed.latestVersion, "0.2.0");
      const after = readdirSync(work).filter((n) => n.startsWith(".rios-backup-")).length;
      assert.equal(after, before, "a check-only should never touch the install");
    });

    await t.test("apply refuses to touch a git checkout", async () => {
      // Release zips never contain .git, so .git == a development checkout.
      mkdirSync(join(appDir, ".git"), { recursive: true });
      const { code, stderr } = await runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/latest.json")
      ]);
      assert.notEqual(code, 0, "updater should refuse a git checkout");
      assert.match(stderr, /git/i);
      assert.equal(
        JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version,
        "0.1.0",
        "checkout was modified"
      );
      assert.ok(existsSync(join(appDir, ".git")), ".git went missing");
    });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(work, { recursive: true, force: true });
  }
});
