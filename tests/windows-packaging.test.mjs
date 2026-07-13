import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  checksumForArchive,
  nodeArchiveName,
  windowsRuntimeDir
} from "../scripts/prepare-windows-runtime.mjs";
import { npmInvocation } from "../scripts/build-windows-installer.mjs";

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
  assert.deepEqual(pkg.build.win.target[0], { target: "nsis", arch: ["x64"] });
  assert.equal(pkg.build.extraResources[0].from, "build/windows-runtime/${arch}");
  assert.equal(pkg.build.extraResources[0].to, "runtime/node");
  assert.equal(pkg.dependencies.prisma, "^6.3.1");
  assert.equal(runnerPkg.dependencies["onnxruntime-node"], "1.21.0");
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
