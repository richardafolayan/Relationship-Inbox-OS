// Regression guards for the non-admin / portable Node install.
//
// 1. A pilot on a standard (non-admin) macOS account hit a hard failure:
//      "<user> is not in the sudoers file. ... Installing Node 22 failed."
//    because the installer ran `sudo installer -pkg` to install Node, which
//    needs admin rights. Node must install WITHOUT sudo.
// 2. Then a pilot hit "na...: unbound variable" on `$na…` because /bin/bash
//    3.2 in a UTF-8 locale (the macOS Terminal default) absorbs a multibyte
//    char immediately following an UNBRACED $var into the variable NAME.
//
// These tests just read the shell scripts, so they run on any platform (Linux CI included).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASH_SCRIPTS = ["scripts/install-student-macos.sh", "scripts/uninstall-student-macos.sh"];
const INSTALLER = readFileSync(path.join(REPO_ROOT, BASH_SCRIPTS[0]), "utf8");
const UNINSTALL = readFileSync(path.join(REPO_ROOT, BASH_SCRIPTS[1]), "utf8");

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

test("bash scripts never glue an unbraced $var to a non-ASCII char", () => {
  // bash 3.2 in a UTF-8 locale folds a multibyte char that immediately
  // follows an unbraced $var INTO the variable name -> unbound-variable
  // error. Put a space, an ASCII char, or `${braces}` between a $var and any
  // non-ASCII character. (Detected by codepoint so this file stays ASCII.)
  const re = /\$[A-Za-z_][A-Za-z0-9_]*(.)/gs;
  for (const rel of BASH_SCRIPTS) {
    const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    let match;
    while ((match = re.exec(src)) !== null) {
      const next = match[1];
      assert.ok(
        next.charCodeAt(0) <= 127,
        `${rel}: unbraced "${match[0]}" glues a $var to a non-ASCII char (codepoint ${next.charCodeAt(0)})`,
      );
    }
  }
});
