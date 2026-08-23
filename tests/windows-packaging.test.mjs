import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  checksumForArchive,
  nodeArchiveName,
  windowsRuntimeDir
} from "../scripts/prepare-windows-runtime.mjs";
import { electronBuilderArgs, npmInvocation } from "../scripts/build-windows-installer.mjs";

test("Windows runtime helpers select the verified Node archive", () => {
  assert.equal(nodeArchiveName("22.21.1", "x64"), "node-v22.21.1-win-x64.zip");
  assert.equal(
    checksumForArchive(
      "abc123  node-v22.21.1-win-x64.zip\ndef456  node-v22.21.1-win-arm64.zip\n",
      "node-v22.21.1-win-x64.zip"
    ),
    "abc123"
  );
  assert.equal(
    windowsRuntimeDir("/repo", "x64"),
    resolve("/repo/build/windows-runtime/x64")
  );
  assert.throws(() => nodeArchiveName("22.21.1", "ia32"), /Unsupported Windows architecture/);
});

test("package config builds an unpacked NSIS app with an external Node runtime", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const runnerPkg = JSON.parse(readFileSync(resolve("apps/runner/package.json"), "utf8"));
  assert.equal(pkg.scripts["build:windows"], "node scripts/build-windows-installer.mjs");
  assert.equal(pkg.build.asar, false);
  assert.equal(pkg.build.npmRebuild, false);
  assert.ok(pkg.build.files.includes("scripts/start-app.mjs"));
  assert.ok(pkg.build.files.includes("scripts/install-maintenance.mjs"));
  assert.ok(
    pkg.build.files.includes("scripts/stop-existing-install.mjs"),
    "the packaged start-app import graph must include its runtime shutdown module"
  );
  assert.ok(pkg.build.files.includes("scripts/lib/**/*"));
  assert.deepEqual(pkg.build.win.target[0], { target: "nsis", arch: ["x64"] });
  assert.equal(pkg.build.extraResources[0].from, "build/windows-runtime/${arch}");
  assert.equal(pkg.build.extraResources[0].to, "runtime/node");
  assert.equal(
    pkg.build.extraResources[1].from,
    "node_modules/onnxruntime-node/bin/napi-v3/win32/x64"
  );
  assert.equal(
    pkg.build.extraResources[1].to,
    "app/node_modules/onnxruntime-node/bin/napi-v3/win32/x64"
  );
  assert.equal(
    pkg.build.extraResources[2].from,
    "node_modules/better-sqlite3"
  );
  assert.equal(
    pkg.build.extraResources[2].to,
    "app/node_modules/better-sqlite3"
  );
  assert.deepEqual(
    pkg.build.extraResources[2].filter,
    ["package.json", "lib/**/*", "build/Release/better_sqlite3.node"]
  );
  assert.deepEqual(pkg.build.extraResources[3], {
    from: "node_modules/next",
    to: "app/node_modules/next"
  });
  assert.equal(pkg.dependencies.prisma, "^6.3.1");
  assert.equal(runnerPkg.dependencies["onnxruntime-node"], "1.21.0");
});

test("packaged legacy migration contains every helper passed by desktop main", () => {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const main = readFileSync(resolve("apps/desktop/main.cjs"), "utf8");
  const helpers = [
    ["backupScript", "scripts/lib/backup-sqlite.mjs", "scripts/lib/**/*"],
    ["lockScript", "scripts/install-maintenance.mjs", "scripts/install-maintenance.mjs"],
    ["stopScript", "scripts/stop-existing-install.mjs", "scripts/stop-existing-install.mjs"]
  ];
  for (const [property, path, packagedEntry] of helpers) {
    assert.match(main, new RegExp(`${property}: join\\(APP_DIR, ${path.split("/").map((part) => `"${part}"`).join(", ")}\\)`));
    assert.equal(existsSync(join(resolve("."), path)), true, `${path} is missing from the source tree`);
    assert.ok(pkg.build.files.includes(packagedEntry), `${path} is missing from the Windows package closure`);
  }
});

test("Windows builder invokes npm through Node instead of the npm.cmd shim", () => {
  const invocation = npmInvocation(["run", "db:generate"], {
    npm_execpath: "C:\\hostedtoolcache\\node\\npm-cli.js"
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    "C:\\hostedtoolcache\\node\\npm-cli.js",
    "run",
    "db:generate"
  ]);
});

test("Windows builder applies the configured display name", () => {
  const args = electronBuilderArgs("Lumen");
  assert.ok(args.includes("--config.productName=Lumen"));
  assert.ok(args.includes("--config.win.artifactName=Lumen-Setup-${version}-${arch}.${ext}"));
  assert.ok(args.includes("--config.nsis.shortcutName=Lumen"));
});
