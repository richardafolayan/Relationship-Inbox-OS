// Verifies the student installer's relocate behaviour:
//   1. The ZIP / in-folder route installs into ~/RelationshipInboxOS (here an
//      overridable RIOS_INSTALL_DIR), not wherever it was unzipped.
//   2. Re-running over an existing install refreshes the code but KEEPS the
//      user's .env and data/ (never deletes user data).
//
// The installer is macOS-only (it `die`s on non-Darwin), so these run on macOS
// and skip elsewhere (e.g. Linux CI). We use --skip-deps so no Node install,
// npm install, database setup, or app launch happens — only the file
// operations under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install-student-macos.sh");

const MACOS = process.platform === "darwin";
const skip = MACOS ? false : "installer is macOS-only";

function read(p) {
  return fs.readFileSync(p, "utf8");
}

// Build a fake "unzipped app" source folder that looks like the real repo to
// the installer (package.json names the app; the real installer script lives
// in scripts/ so BASH_SOURCE resolves to an app root).
function makeSource(root, codeVersion) {
  const src = path.join(root, "download", "relationship-inbox-os");
  fs.mkdirSync(path.join(src, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-test" }, null, 2),
  );
  fs.writeFileSync(path.join(src, ".env.example"), "NEXT_PUBLIC_APP_VERSION=0.0.0-test\nAI_PROVIDER=openai\n");
  fs.writeFileSync(path.join(src, "CODE_VERSION.txt"), codeVersion);
  fs.copyFileSync(INSTALLER, path.join(src, "scripts", "install-student-macos.sh"));
  return src;
}

function runInstaller(src, installDir, home) {
  return spawnSync("bash", [path.join(src, "scripts", "install-student-macos.sh"), "--skip-deps"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, RIOS_INSTALL_DIR: installDir, RIOS_NO_START: "1" },
  });
}

test("fresh ZIP install lands in the install dir, leaves the source in place", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-fresh-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");
    const src = makeSource(home, "v1-fresh");

    const r = runInstaller(src, installDir, home);
    assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);

    // Code landed in the predictable install dir.
    assert.ok(fs.existsSync(installDir), "install dir was created");
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v1-fresh", "app code copied in");
    assert.ok(fs.existsSync(path.join(installDir, "package.json")), "package.json copied in");

    // The source (e.g. Downloads) is only read, never moved/deleted.
    assert.ok(fs.existsSync(path.join(src, "CODE_VERSION.txt")), "source folder left intact");

    // .env created from the template with an absolute DATABASE_URL under the install dir.
    const env = read(path.join(installDir, ".env"));
    assert.match(env, /^DATABASE_URL=file:.+\/data\/inbox-os\.sqlite$/m, "DATABASE_URL pinned absolute");
    assert.match(env, /^BROWSER_PROFILE_MODE=personal$/m, "personal browser mode set");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-install over an existing install keeps .env and data, refreshes code", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rios-install-update-"));
  try {
    const installDir = path.join(home, "RelationshipInboxOS");

    // Pre-existing install with USER data we must not lose.
    fs.mkdirSync(path.join(installDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "relationship-inbox-os", version: "0.0.0-old" }, null, 2),
    );
    fs.writeFileSync(path.join(installDir, ".env"), "MY_SECRET=keepme\nOPENAI_API_KEY=sk-existing\n");
    fs.writeFileSync(path.join(installDir, "data", "inbox-os.sqlite"), "DBDATA-PRESERVE-ME");
    fs.writeFileSync(path.join(installDir, "CODE_VERSION.txt"), "v1-old");

    const src = makeSource(home, "v2-new");
    const r = runInstaller(src, installDir, home);
    assert.equal(r.status, 0, `installer failed:\n${r.stdout}\n${r.stderr}`);

    // Code refreshed...
    assert.equal(read(path.join(installDir, "CODE_VERSION.txt")), "v2-new", "code was updated");
    // ...but the user's settings and database survived.
    assert.match(read(path.join(installDir, ".env")), /^MY_SECRET=keepme$/m, ".env preserved");
    assert.equal(
      read(path.join(installDir, "data", "inbox-os.sqlite")),
      "DBDATA-PRESERVE-ME",
      "database preserved byte-for-byte",
    );

    // No staging/backup leftovers beside the install dir.
    const siblings = fs.readdirSync(home);
    assert.ok(
      !siblings.some((n) => n.startsWith("RelationshipInboxOS.new-") || n === "RelationshipInboxOS.previous"),
      `temp install artefacts left behind: ${siblings.join(", ")}`,
    );

    // Source still intact (never the live copy).
    assert.ok(fs.existsSync(path.join(src, "CODE_VERSION.txt")), "source folder left intact");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
