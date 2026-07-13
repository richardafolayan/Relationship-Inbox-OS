import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";
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
    "packages/core/prisma/schema.prisma"
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
        "packages/core/prisma/schema.prisma"
      ]
    }
  );
});
