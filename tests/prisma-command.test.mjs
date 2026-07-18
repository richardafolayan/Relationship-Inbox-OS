import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
import { packagedDashboardArgs } from "../scripts/lib/dashboard-command.mjs";
import { prismaDbPushInvocation } from "../scripts/lib/prisma-command.mjs";

test("packaged Windows database setup invokes Prisma with bundled Node", () => {
  const invocation = prismaDbPushInvocation({
    appDir: "C:\\Program Files\\Tovi\\resources\\app",
    packaged: true,
    nodeExecutable: "C:\\Program Files\\Tovi\\resources\\runtime\\node\\node.exe",
    npmCommand: "npm.cmd",
    platform: "win32"
  });
  assert.equal(
    invocation.command,
    "C:\\Program Files\\Tovi\\resources\\runtime\\node\\node.exe"
  );
  assert.deepEqual(invocation.args, [
    win32.join(
      "C:\\Program Files\\Tovi\\resources\\app",
      "node_modules",
      "prisma",
      "build",
      "index.js"
    ),
    "db",
    "push",
    "--schema",
    "packages/core/prisma/schema.prisma",
    "--skip-generate"
  ]);
});

test("development database setup still uses the package manager", () => {
  assert.deepEqual(
    prismaDbPushInvocation({ appDir: "/repo", packaged: false, npmCommand: "npm" }),
    {
      command: "npm",
      args: [
        "exec",
        "--",
        "prisma",
        "db",
        "push",
        "--schema",
        "packages/core/prisma/schema.prisma",
        "--skip-generate"
      ]
    }
  );
});

test("packaged Windows dashboard starts from its production build directory", () => {
  const appDir = "C:\\Program Files\\Tovi\\resources\\app";
  assert.deepEqual(packagedDashboardArgs(appDir, "3100", "win32"), [
    win32.join(appDir, "node_modules", "next", "dist", "bin", "next"),
    "start",
    win32.join(appDir, "apps", "dashboard"),
    "-p",
    "3100",
    "-H",
    "127.0.0.1"
  ]);
});
