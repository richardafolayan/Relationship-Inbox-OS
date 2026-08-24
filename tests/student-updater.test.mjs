import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acquireInstallOperation,
  acquireInstallPreparation,
  installOperationPath,
  releaseInstallOperation,
  releaseInstallPreparation
} from "../scripts/lib/install-maintenance.mjs";
import {
  beginInstallTransaction,
  clearInstallTransaction,
  installRecoveryBootstrapPath,
  installScopeKey,
  installTransactionPath,
  moveInstallTransaction,
  rollbackInstallTransaction
} from "../scripts/lib/install-transaction.mjs";
import { processIsAlive } from "../scripts/lib/process-lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER = join(ROOT, "scripts", "update-student.mjs");

// Spawn the updater async so this process's HTTP server keeps serving while
// the child fetches from it (execFileSync would deadlock the event loop).
function runUpdater(args, options = {}) {
  return new Promise((resolve) => {
    const appDirIndex = args.indexOf("--dir");
    const appDir = appDirIndex >= 0 ? args[appDirIndex + 1] : ROOT;
    const child = spawn(process.execPath, [UPDATER, ...args], {
      ...options,
      env: {
        ...process.env,
        RIOS_INSTALL_TRANSACTION_DIR: join(dirname(appDir), ".test-install-transactions"),
        ...(options.env || {})
      }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runUpdaterThroughStartWrapper(appDir, args, continuationPath, options = {}) {
  const wrapper = join(appDir, "scripts", "start-student.mjs");
  writeFileSync(
    wrapper,
    `import { spawn } from "node:child_process";
     import { writeFileSync } from "node:fs";
     const updater = spawn(process.execPath, ${JSON.stringify([UPDATER, ...args])}, {
       cwd: ${JSON.stringify(appDir)},
       env: process.env,
       stdio: "inherit"
     });
     updater.once("close", (code, signal) => {
       writeFileSync(${JSON.stringify(continuationPath)}, JSON.stringify({ code, signal }));
       process.exitCode = code ?? 1;
     });`
  );
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [wrapper], {
      ...options,
      cwd: appDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
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

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

function createPackagedInstall(bundle, { validBundle = true } = {}) {
  const app = join(bundle, "Contents", "Resources", "app");
  mkdirSync(join(app, "data"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "relationship-inbox-os", version: "0.1.0" }));
  writeFileSync(join(app, "release.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(app, ".env"), "OPENAI_API_KEY=KEEP_ME\n");
  writeFileSync(join(app, "data", "inbox-os.sqlite"), "USER_DATA");
  if (validBundle) {
    const executable = join(bundle, "Contents", "MacOS", "Tovi");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    writeFileSync(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.test.tovi</string>
<key>CFBundleExecutable</key><string>Tovi</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`);
  }
  return app;
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
  mkdirSync(join(inner, "scripts", "lib"), { recursive: true });
  for (const file of ["install-maintenance.mjs", "install-transaction.mjs", "process-lifecycle.mjs", "run-with-install-lease.mjs"]) {
    cpSync(join(ROOT, "scripts", "lib", file), join(inner, "scripts", "lib", file));
  }
  const zipPath = join(work, "app.zip");
  execFileSync("zip", ["-r", "-q", zipPath, "relationship-inbox-os"], { cwd: stage });
  const zipBuf = readFileSync(zipPath);
  const sha = createHash("sha256").update(zipBuf).digest("hex");

  const manifest = (zipUrl, sha256 = sha, version = "0.2.0") =>
    JSON.stringify({
      version, build: "2026-06-06T00:00:00Z", commit: "deadbee",
      zipUrl, sha256, releaseNotes: ["New stuff"], minimumInstallerVersion: "0.1.0"
    });

  let markRaceZipRequested;
  let releaseRaceZip;
  const raceZipRequested = new Promise((resolveRequested) => (markRaceZipRequested = resolveRequested));
  const raceZipReleased = new Promise((resolveReleased) => (releaseRaceZip = resolveReleased));
  let markLeaseRaceZipRequested;
  let releaseLeaseRaceZip;
  const leaseRaceZipRequested = new Promise((resolveRequested) => (markLeaseRaceZipRequested = resolveRequested));
  const leaseRaceZipReleased = new Promise((resolveReleased) => (releaseLeaseRaceZip = resolveReleased));

  let PORT;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/downgraded-redirect.json")) {
      res.writeHead(302, { Location: `http://0.0.0.0:${PORT}/latest.json` });
      return res.end();
    }
    if (req.url.startsWith("/redirect-chain.json")) {
      res.writeHead(302, { Location: `http://0.0.0.0:${PORT}/redirect-chain-back.json` });
      return res.end();
    }
    if (req.url.startsWith("/redirect-chain-back.json")) {
      res.writeHead(302, { Location: `http://localhost:${PORT}/latest.json` });
      return res.end();
    }
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { Location: `http://localhost:${PORT}/latest.json` });
      return res.end();
    }
    if (req.url.startsWith("/latest.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/app.zip`));
    }
    if (req.url.startsWith("/race.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/race-app.zip`));
    }
    if (req.url.startsWith("/lease-race.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(manifest(`http://localhost:${PORT}/lease-race-app.zip`));
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
    if (req.url.startsWith("/race-app.zip")) {
      markRaceZipRequested();
      void raceZipReleased.then(() => {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(zipBuf);
      });
      return;
    }
    if (req.url.startsWith("/lease-race-app.zip")) {
      markLeaseRaceZipRequested();
      void leaseRaceZipReleased.then(() => {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(zipBuf);
      });
      return;
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

    await t.test("check-only does not recover a journal or signal a live runtime", async () => {
      const checkApp = join(work, "check-only-app");
      const stagingRoot = join(work, "check-only-staging");
      const stagedApp = join(stagingRoot, "app");
      const backupDir = join(work, ".check-only-backup");
      const transactionRoot = join(work, ".test-install-transactions");
      const signalMarker = join(work, "check-only-runtime-signalled");
      mkdirSync(join(checkApp, "scripts"), { recursive: true });
      mkdirSync(stagedApp, { recursive: true });
      writeFileSync(join(checkApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.0"
      }));
      writeFileSync(join(checkApp, "release.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(stagedApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.2.0"
      }));
      writeFileSync(join(stagedApp, "release.json"), JSON.stringify({ version: "0.2.0" }));
      writeFileSync(
        join(checkApp, "scripts", "start-app.mjs"),
        `import { writeFileSync } from "node:fs";
         process.on("SIGTERM", () => {
           writeFileSync(${JSON.stringify(signalMarker)}, "SIGTERM");
           process.exit(0);
         });
         process.send("ready");
         setInterval(() => {}, 1000);`
      );
      const transaction = beginInstallTransaction({
        appDir: checkApp,
        backupDir,
        backupRoot: work,
        kind: "check-only-regression",
        stagedApp,
        stagingRoot
      }, { rootDir: transactionRoot });
      const runtime = spawn(process.execPath, [join(checkApp, "scripts", "start-app.mjs")], {
        cwd: checkApp,
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      });
      try {
        await new Promise((resolveReady, reject) => {
          runtime.once("message", resolveReady);
          runtime.once("error", reject);
          runtime.once("exit", (code, signal) => reject(new Error(`runtime exited early (${code ?? signal})`)));
        });
        const { code, stdout, stderr } = await runUpdater([
          "--check-only", "--json", "--dir", checkApp, "--url", url("/latest.json")
        ]);
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        assert.equal(runtime.exitCode, null, "check-only terminated the running app");
        assert.equal(runtime.signalCode, null, "check-only signalled the running app");
        assert.equal(existsSync(signalMarker), false);
        assert.equal(existsSync(installTransactionPath(checkApp, { rootDir: transactionRoot })), true);
        assert.equal(JSON.parse(readFileSync(join(checkApp, "package.json"), "utf8")).version, "0.1.0");
        assert.equal(JSON.parse(readFileSync(join(stagedApp, "package.json"), "utf8")).version, "0.2.0");
      } finally {
        clearInstallTransaction(checkApp, transaction.operationId, { rootDir: transactionRoot });
        try { process.kill(runtime.pid, "SIGKILL"); } catch {}
        await waitForExit(runtime).catch(() => {});
      }
    });

    await t.test("redirects cannot downgrade update transport policy", async () => {
      const { code, stderr } = await runUpdater([
        "--check-only", "--json", "--dir", appDir, "--url", url("/downgraded-redirect.json")
      ]);
      assert.notEqual(code, 0);
      assert.match(stderr, /redirect to a non-https URL/i);
    });

    await t.test("an insecure intermediate redirect is rejected even if its next hop would be allowed", async () => {
      const { code, stderr } = await runUpdater([
        "--check-only", "--json", "--dir", appDir, "--url", url("/redirect-chain.json")
      ]);
      assert.notEqual(code, 0);
      assert.match(stderr, /redirect to a non-https URL/i);
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

    await t.test("a downloaded stale package cannot overwrite a newer concurrent install", async () => {
      const updating = runUpdater([
        "--apply", "--no-deps", "--dir", appDir, "--url", url("/race.json")
      ]);
      await raceZipRequested;
      writeFileSync(join(appDir, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.3.0"
      }));
      writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.3.0" }));
      releaseRaceZip();

      const { code, stdout, stderr } = await updating;
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.match(stdout, /already updated this app to 0\.3\.0/i);
      assert.equal(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version, "0.3.0");
      assert.ok(!existsSync(join(appDir, "NEWCODE.txt")));
      assert.equal(readdirSync(work).some((name) => name.startsWith(".rios-backup-")), false);

      writeFileSync(join(appDir, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.0"
      }));
      writeFileSync(join(appDir, "release.json"), JSON.stringify({ version: "0.1.0" }));
    });

    await t.test("a late crashed transaction is not recovered while its protected worker lives", {
      skip: process.platform === "win32"
    }, async () => {
      const leaseApp = join(work, "late-transaction-app");
      const transactionRoot = join(work, ".test-install-transactions");
      const priorStagingRoot = join(work, ".late-prior-stage");
      const priorStagedApp = join(priorStagingRoot, "relationship-inbox-os");
      const priorBackup = join(work, `.rios-backup-${installScopeKey(leaseApp)}-prior`);
      const workerScript = join(work, "protected-install-worker.mjs");
      const workerMarker = join(work, "protected-install-worker.pid");
      mkdirSync(leaseApp, { recursive: true });
      mkdirSync(priorStagedApp, { recursive: true });
      writeFileSync(join(leaseApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.0"
      }));
      writeFileSync(join(leaseApp, "release.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(priorStagedApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.5"
      }));
      writeFileSync(join(priorStagedApp, "release.json"), JSON.stringify({ version: "0.1.5" }));
      writeFileSync(workerScript, `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(workerMarker)}, String(process.pid));
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `);

      let updateSettled = false;
      const updating = runUpdater([
        "--apply", "--no-deps", "--dir", leaseApp, "--url", url("/lease-race.json")
      ]).then((result) => {
        updateSettled = true;
        return result;
      });
      await leaseRaceZipRequested;

      const priorTransaction = beginInstallTransaction({
        appDir: leaseApp,
        backupDir: priorBackup,
        backupRoot: work,
        kind: "late-crashed-update",
        stagedApp: priorStagedApp,
        stagingRoot: priorStagingRoot
      }, { rootDir: transactionRoot });
      moveInstallTransaction(leaseApp, priorTransaction.operationId, "move-old", { rootDir: transactionRoot });
      moveInstallTransaction(leaseApp, priorTransaction.operationId, "publish", { rootDir: transactionRoot });

      const preparationToken = acquireInstallPreparation(leaseApp);
      const wrapper = spawn(process.execPath, [
        join(ROOT, "scripts", "lib", "run-with-install-lease.mjs"),
        "--app-dir", leaseApp,
        "--token", preparationToken,
        "--",
        process.execPath,
        workerScript
      ], { stdio: "ignore" });
      let workerPid = 0;
      let workerGroup = 0;
      try {
        await waitFor(() => existsSync(workerMarker), "protected worker did not start");
        workerPid = Number(readFileSync(workerMarker, "utf8"));
        workerGroup = Number(execFileSync("ps", ["-p", String(workerPid), "-o", "pgid="], {
          encoding: "utf8"
        }).trim());
        wrapper.kill("SIGKILL");
        await waitForExit(wrapper);
        assert.equal(releaseInstallPreparation(leaseApp, preparationToken), true);
        releaseLeaseRaceZip();
        await delay(500);

        assert.equal(updateSettled, false, "the second updater ignored the protected preparation lease");
        assert.equal(JSON.parse(readFileSync(join(leaseApp, "package.json"), "utf8")).version, "0.1.5");
        assert.equal(existsSync(priorBackup), true, "the prior app moved while its worker was alive");

        process.kill(-workerGroup, "SIGKILL");
        await waitFor(() => !processIsAlive(workerPid), "protected worker did not stop");
        const { code, stdout, stderr } = await updating;
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        assert.equal(JSON.parse(readFileSync(join(leaseApp, "package.json"), "utf8")).version, "0.2.0");
      } finally {
        try { wrapper.kill("SIGKILL"); } catch {}
        if (workerGroup) {
          try { process.kill(-workerGroup, "SIGKILL"); } catch {}
        }
        if (!updateSettled) releaseLeaseRaceZip();
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
        const continuationPath = join(work, "start-wrapper-continued.json");
        const updateArgs = [
          "--apply", "--no-deps", "--dir", appDir, "--url", url("/latest.json")
        ];
        const { code, signal, stdout, stderr } = await runUpdaterThroughStartWrapper(
          appDir,
          updateArgs,
          continuationPath
        );
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        assert.equal(signal, null, "the start wrapper must not be killed by its updater");
        assert.deepEqual(JSON.parse(readFileSync(continuationPath, "utf8")), { code: 0, signal: null });
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

    await t.test("SIGKILL during dependency preparation restores the old app on recovery", {
      skip: process.platform === "win32"
    }, async () => {
      const crashApp = join(work, "crash-during-deps-app");
      const transactionRoot = join(work, ".test-install-transactions");
      const fakeBin = join(work, "crash-during-deps-bin");
      const npmMarker = join(work, "crash-during-deps-npm.json");
      const npmRelease = join(work, "crash-during-deps-release");
      mkdirSync(join(crashApp, "data"), { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(crashApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.0"
      }));
      writeFileSync(join(crashApp, "release.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(crashApp, ".env"), "OPENAI_API_KEY=CRASH_SAFE\n");
      writeFileSync(join(crashApp, "data", "inbox-os.sqlite"), "CRASH_SAFE_DATA");
      writeFileSync(
        join(fakeBin, "npm"),
        `#!/bin/sh
printf '{"pid":%s}\n' "$$" > "$TEST_NPM_MARKER"
trap 'exit 143' TERM INT HUP
while [ ! -f "$TEST_NPM_RELEASE" ]; do sleep 0.1; done
exit 1
`
      );
      chmodSync(join(fakeBin, "npm"), 0o755);

      const child = spawn(process.execPath, [
        UPDATER,
        "--apply",
        "--dir", crashApp,
        "--url", url("/latest.json")
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          RIOS_INSTALL_TRANSACTION_DIR: transactionRoot,
          TEST_NPM_MARKER: npmMarker,
          TEST_NPM_RELEASE: npmRelease
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      try {
        await waitFor(
          () => existsSync(npmMarker) && existsSync(installTransactionPath(crashApp, { rootDir: transactionRoot })),
          `updater did not reach dependency preparation\n${stdout}\n${stderr}`,
          15_000
        );
        assert.equal(JSON.parse(readFileSync(join(crashApp, "package.json"), "utf8")).version, "0.2.0");
        child.kill("SIGKILL");
        await waitForExit(child);
        const npmPid = JSON.parse(readFileSync(npmMarker, "utf8")).pid;
        assert.equal(processIsAlive(npmPid), true, "protected dependency work ended with its updater parent");
        assert.throws(
          () => acquireInstallPreparation(crashApp),
          /already changing/i,
          "recovery was not fenced while the orphaned worker remained alive"
        );
        writeFileSync(npmRelease, "finish");
        await waitFor(() => !processIsAlive(npmPid), "dependency worker survived its updater", 8_000);
        let recoveryPreparationToken = "";
        await waitFor(() => {
          try {
            recoveryPreparationToken = acquireInstallPreparation(crashApp);
            return true;
          } catch {
            return false;
          }
        }, "orphaned preparation lease was not released", 8_000);
        releaseInstallPreparation(crashApp, recoveryPreparationToken);

        const bootstrap = installRecoveryBootstrapPath(crashApp, { rootDir: transactionRoot });
        const recovery = spawn(process.execPath, [
          bootstrap,
          "recover",
          "--app-dir", crashApp,
          "--transaction-root", transactionRoot
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let recoveryOut = "";
        let recoveryErr = "";
        recovery.stdout.on("data", (chunk) => (recoveryOut += chunk));
        recovery.stderr.on("data", (chunk) => (recoveryErr += chunk));
        const recoveryCode = await new Promise((resolveExit) => recovery.once("close", resolveExit));
        assert.equal(recoveryCode, 0, `${recoveryOut}\n${recoveryErr}`);
        assert.match(recoveryOut, /restored-old/);
        assert.equal(JSON.parse(readFileSync(join(crashApp, "package.json"), "utf8")).version, "0.1.0");
        assert.equal(readFileSync(join(crashApp, ".env"), "utf8"), "OPENAI_API_KEY=CRASH_SAFE\n");
        assert.equal(readFileSync(join(crashApp, "data", "inbox-os.sqlite"), "utf8"), "CRASH_SAFE_DATA");
        assert.equal(existsSync(join(crashApp, "NEWCODE.txt")), false);
        assert.equal(existsSync(installTransactionPath(crashApp, { rootDir: transactionRoot })), false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch {}
          await waitForExit(child).catch(() => {});
        }
      }
    });

    await t.test("backup pruning cannot delete another install's active rollback copy", async () => {
      const pruningApp = join(work, "pruning-app");
      const otherApp = join(work, "other-active-app");
      const otherStagingRoot = join(work, ".other-active-stage");
      const otherStagedApp = join(otherStagingRoot, "relationship-inbox-os");
      const transactionRoot = join(work, ".test-install-transactions");
      const otherBackup = join(work, `.rios-backup-${installScopeKey(otherApp)}-active`);
      for (const path of [pruningApp, otherApp, otherStagedApp]) mkdirSync(path, { recursive: true });
      writeFileSync(join(pruningApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "0.1.0"
      }));
      writeFileSync(join(pruningApp, "release.json"), JSON.stringify({ version: "0.1.0" }));
      writeFileSync(join(otherApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "7.0.0"
      }));
      writeFileSync(join(otherApp, "release.json"), JSON.stringify({ version: "7.0.0" }));
      writeFileSync(join(otherStagedApp, "package.json"), JSON.stringify({
        name: "relationship-inbox-os",
        version: "8.0.0"
      }));
      writeFileSync(join(otherStagedApp, "release.json"), JSON.stringify({ version: "8.0.0" }));
      const otherTransaction = beginInstallTransaction({
        appDir: otherApp,
        backupDir: otherBackup,
        backupRoot: work,
        kind: "other-concurrent-update",
        stagedApp: otherStagedApp,
        stagingRoot: otherStagingRoot
      }, { rootDir: transactionRoot });
      moveInstallTransaction(otherApp, otherTransaction.operationId, "move-old", { rootDir: transactionRoot });
      moveInstallTransaction(otherApp, otherTransaction.operationId, "publish", { rootDir: transactionRoot });
      try {
        const { code, stdout, stderr } = await runUpdater([
          "--apply", "--no-deps", "--keep-backups", "0",
          "--dir", pruningApp, "--url", url("/latest.json")
        ]);
        assert.equal(code, 0, `${stdout}\n${stderr}`);
        assert.equal(JSON.parse(readFileSync(join(pruningApp, "package.json"), "utf8")).version, "0.2.0");
        assert.equal(existsSync(otherBackup), true, "another install's live rollback copy was pruned");
        assert.equal(JSON.parse(readFileSync(join(otherBackup, "package.json"), "utf8")).version, "7.0.0");
        assert.equal(existsSync(installTransactionPath(otherApp, { rootDir: transactionRoot })), true);
      } finally {
        if (existsSync(installTransactionPath(otherApp, { rootDir: transactionRoot }))) {
          rollbackInstallTransaction(otherApp, otherTransaction.operationId, { rootDir: transactionRoot });
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

    await t.test("packaged storage and backup aliases cannot resolve inside the signed bundle", async () => {
      if (process.platform === "win32") return;
      for (const kind of ["config", "data", "state", "backup"]) {
        const bundle = join(work, `Alias-${kind}-Tovi.app`);
        const packagedAppDir = createPackagedInstall(bundle);
        const inside = join(packagedAppDir, `unsafe-${kind}`);
        const alias = join(work, `external-looking-${kind}`);
        mkdirSync(inside, { recursive: true });
        symlinkSync(inside, alias, "dir");
        const updaterArgs = [
          "--check-only", "--json", "--dir", packagedAppDir,
          "--url", url("/latest.json"), "--resign", bundle
        ];
        if (kind === "backup") updaterArgs.push("--backup-root", alias);
        const env = {
          ...process.env,
          RIOS_CONFIG_DIR: kind === "config" ? alias : join(work, `${kind}-safe-config`),
          RIOS_DATA_DIR: kind === "data" ? alias : join(work, `${kind}-safe-data`),
          RIOS_STATE_DIR: kind === "state" ? alias : join(work, `${kind}-safe-state`)
        };
        const { code, stderr } = await runUpdater(updaterArgs, { env });
        assert.notEqual(code, 0, `${kind} alias was accepted`);
        assert.match(stderr, /outside the signed app bundle/i);
      }
    });

    await t.test("signed packaged apps reject source replacement before build or database work", async () => {
      const fakeBin = join(work, "fake-bin");
      const commandLog = join(work, "packaged-command.log");
      const externalDatabase = join(work, "external.sqlite");
      const appBundle = join(work, "Tovi.app");
      const packagedAppDir = createPackagedInstall(appBundle);
      const configDir = join(work, "packaged-config");
      const dataDir = join(work, "packaged-data");
      const stateDir = join(work, "packaged-state");
      mkdirSync(fakeBin, { recursive: true });
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

      const { code, stderr } = await runUpdater([
        "--apply", "--dir", packagedAppDir, "--url", url("/latest.json"), "--resign", appBundle
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          RIOS_CONFIG_DIR: configDir,
          RIOS_DATA_DIR: dataDir,
          RIOS_STATE_DIR: stateDir,
          TEST_COMMAND_LOG: commandLog,
          TEST_DATABASE_MARKER: externalDatabase
        }
      });

      assert.notEqual(code, 0, "a failed packaged build must abort the update");
      assert.match(stderr, /native whole-app updater/i);
      assert.equal(readFileSync(externalDatabase, "utf8"), "USER_DATA");
      assert.equal(JSON.parse(readFileSync(join(packagedAppDir, "package.json"), "utf8")).version, "0.1.0");
      assert.equal(existsSync(commandLog), false);
    });

    await t.test("a packaged signature failure restores the previous app before database work", async () => {
      const fakeBin = join(work, "fake-signature-bin");
      const commandLog = join(work, "signature-command.log");
      const externalDatabase = join(work, "signature-external.sqlite");
      const appBundle = join(work, "Unsigned-Tovi.app");
      const packagedAppDir = createPackagedInstall(appBundle, { validBundle: false });
      const configDir = join(work, "signature-config");
      const dataDir = join(work, "signature-data");
      const stateDir = join(work, "signature-state");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(externalDatabase, "USER_DATA");
      writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$TEST_COMMAND_LOG"\nexit 0\n`);
      chmodSync(join(fakeBin, "npm"), 0o755);
      writeFileSync(join(fakeBin, "node"), `#!/bin/sh
printf 'node %s\\n' "$*" >> "$TEST_COMMAND_LOG"
case " $* " in
  *" --build-only "*)
    mkdir -p packages/core/dist apps/runner/dist apps/dashboard/.next
    : > packages/core/dist/index.js
    : > apps/runner/dist/index.js
    : > apps/dashboard/.next/BUILD_ID
    ;;
  *" --database-only "*) printf 'MUTATED' > "$TEST_DATABASE_MARKER" ;;
esac
exit 0
`);
      chmodSync(join(fakeBin, "node"), 0o755);
      writeFileSync(join(fakeBin, "codesign"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(fakeBin, "codesign"), 0o755);

      const { code, stdout, stderr } = await runUpdater([
        "--apply", "--dir", packagedAppDir, "--url", url("/latest.json"), "--resign", appBundle
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          RIOS_CONFIG_DIR: configDir,
          RIOS_DATA_DIR: dataDir,
          RIOS_STATE_DIR: stateDir,
          TEST_COMMAND_LOG: commandLog,
          TEST_DATABASE_MARKER: externalDatabase
        }
      });

      assert.notEqual(code, 0);
      assert.match(stderr, /native whole-app updater/i);
      assert.equal(readFileSync(externalDatabase, "utf8"), "USER_DATA");
      assert.equal(JSON.parse(readFileSync(join(packagedAppDir, "package.json"), "utf8")).version, "0.1.0");
      assert.ok(!existsSync(join(packagedAppDir, "NEWCODE.txt")));
      assert.doesNotMatch(`${stdout}\n${stderr}`, /Updated to 0\.2\.0/);
      assert.equal(existsSync(commandLog), false);
    });

    await t.test("an unrecovered database keeps the new code and never claims rollback safety", async () => {
      const fakeBin = join(work, "fake-database-bin");
      const commandLog = join(work, "database-recovery-command.log");
      const appBundle = join(work, "Recovery-Tovi.app");
      const packagedAppDir = createPackagedInstall(appBundle);
      const configDir = join(work, "recovery-config");
      const dataDir = join(work, "recovery-data");
      const stateDir = join(work, "recovery-state");
      mkdirSync(fakeBin, { recursive: true });

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
  *" --database-only "*) printf 'packaged %s\n' "$RIOS_PACKAGED_APP" >> "$TEST_COMMAND_LOG"; exit 1 ;;
esac
exit 0
`);
      chmodSync(fakeNode, 0o755);
      writeFileSync(join(fakeBin, "codesign"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(fakeBin, "codesign"), 0o755);

      const { code, stdout, stderr } = await runUpdater([
        "--apply", "--dir", packagedAppDir, "--url", url("/latest.json"), "--resign", appBundle
      ], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          RIOS_CONFIG_DIR: configDir,
          RIOS_DATA_DIR: dataDir,
          RIOS_STATE_DIR: stateDir,
          TEST_COMMAND_LOG: commandLog
        }
      });

      assert.equal(code, 1);
      assert.match(stderr, /native whole-app updater/i);
      assert.doesNotMatch(`${stdout}\n${stderr}`, /Your data is safe/i);
      assert.equal(JSON.parse(readFileSync(join(packagedAppDir, "package.json"), "utf8")).version, "0.1.0");
      assert.equal(existsSync(join(packagedAppDir, "NEWCODE.txt")), false);
      assert.equal(existsSync(join(packagedAppDir, ".tovi-installing")), false, "maintenance lock released");
      assert.equal(existsSync(installOperationPath(packagedAppDir)), false, "operation lock released");
      assert.equal(existsSync(commandLog), false);

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
