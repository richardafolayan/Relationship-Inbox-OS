// Regression guard for the non-admin Node install.
//
// A pilot on a standard (non-admin) macOS account hit a hard failure:
//   "<user> is not in the sudoers file. ... Installing Node 22 failed."
// because the installer ran `sudo installer -pkg` to install Node, which
// needs admin rights. Node must install WITHOUT sudo so managed / non-admin
// Macs work. These tests just read the shell scripts, so they run on any
// platform (including Linux CI).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = readFileSync(path.join(REPO_ROOT, "scripts", "install-student-macos.sh"), "utf8");
const UNINSTALL = readFileSync(path.join(REPO_ROOT, "scripts", "uninstall-student-macos.sh"), "utf8");

test("installer never uses sudo / the admin .pkg to install Node", () => {
  assert.ok(!/\bsudo\s+installer\b/.test(INSTALLER), "must not run `sudo installer`");
  assert.ok(!/\binstaller\s+-pkg\b/.test(INSTALLER), "must not use the admin .pkg installer");
});

test("installer installs Node into a user-owned dir from the verified tarball", () => {
  assert.match(INSTALLER, /RIOS_NODE_DIR/, "uses a user-owned node dir");
  assert.match(INSTALLER, /darwin-\$na/, "selects the per-arch darwin tarball");
  assert.match(INSTALLER, /shasum -a 256 -c/, "verifies the tarball checksum");
  assert.match(INSTALLER, /tar -xzf/, "extracts the tarball (no admin)");
  assert.match(INSTALLER, /ensure_node_on_path/, "persists node on PATH for future shells");
});

test("uninstaller cleans up the app's user-local Node + the PATH line", () => {
  assert.match(UNINSTALL, /RIOS_NODE_DIR/, "removes the user-local node dir");
  assert.match(
    UNINSTALL,
    /added by Relationship Inbox OS \(Node on PATH\)/,
    "removes the PATH marker block it added",
  );
});
