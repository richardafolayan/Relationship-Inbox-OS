import assert from "node:assert/strict";
import test from "node:test";

import { planNpmInvocation } from "../scripts/testing/npm-invocation.mjs";

test("Windows npm commands use cmd.exe with validated fixed tokens", () => {
  assert.deepEqual(
    planNpmInvocation(
      "win32",
      ["run", "build", "--workspace", "@inbox-os/core"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd run build --workspace @inbox-os/core"]
    }
  );
  assert.throws(
    () => planNpmInvocation("win32", ["run", "build & whoami"], {}),
    /Unsafe npm argument/
  );
});

test("POSIX npm commands remain direct argv execution", () => {
  assert.deepEqual(planNpmInvocation("linux", ["run", "build"], {}), {
    command: "npm",
    args: ["run", "build"]
  });
});
