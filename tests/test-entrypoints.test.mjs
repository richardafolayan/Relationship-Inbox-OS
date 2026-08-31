import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repoRoot, "scripts/testing/run-tests.mjs");

function fixtureTest(message, options = "") {
  return `import test from "node:test";
${options}
test("fixture", ${options.includes("SKIP_TEST") ? "{ skip: true }, " : ""}() => {
  console.log(${JSON.stringify(message)});
});
`;
}

function run(command, args, testsRoot, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TOVI_TESTS_ROOT: testsRoot,
      ...extraEnv
    },
    maxBuffer: 20 * 1024 * 1024
  });
}

test("workspace test commands execute their real matching child tests", (t) => {
  const testsRoot = mkdtempSync(join(tmpdir(), "tovi-workspace-tests-"));
  t.after(() => rmSync(testsRoot, { recursive: true, force: true }));

  writeFileSync(
    join(testsRoot, "dashboard-entrypoint.test.mjs"),
    fixtureTest("DASHBOARD_ENTRYPOINT_RAN")
  );
  writeFileSync(
    join(testsRoot, "runner-entrypoint.test.mjs"),
    fixtureTest("RUNNER_ENTRYPOINT_RAN")
  );
  writeFileSync(
    join(testsRoot, "core-entrypoint.test.mjs"),
    fixtureTest("CORE_ENTRYPOINT_RAN")
  );

  const cases = [
    ["@inbox-os/dashboard", "DASHBOARD_ENTRYPOINT_RAN"],
    ["@inbox-os/runner", "RUNNER_ENTRYPOINT_RAN"],
    ["@inbox-os/core", "CORE_ENTRYPOINT_RAN"]
  ];
  for (const [workspace, marker] of cases) {
    const result = run("npm", ["test", "--workspace", workspace], testsRoot);
    assert.equal(
      result.status,
      0,
      `${workspace} failed:\n${result.stdout}\n${result.stderr}`
    );
    assert.match(result.stdout, new RegExp(marker));
  }
});

test("browser group includes explicit browser fixtures and runs them serially", (t) => {
  const testsRoot = mkdtempSync(join(tmpdir(), "tovi-browser-tests-"));
  t.after(() => rmSync(testsRoot, { recursive: true, force: true }));
  writeFileSync(
    join(testsRoot, "dashboard-browser-entrypoint.test.mjs"),
    fixtureTest("BROWSER_ENTRYPOINT_RAN", "// @tovi-browser")
  );

  const result = run(process.execPath, [runnerPath, "browser"], testsRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BROWSER_ENTRYPOINT_RAN/);
  assert.match(result.stdout, /browser: 1 file\(s\), concurrency 1/);
});

test("required browser skips fail closed unless the override is explicit", (t) => {
  const testsRoot = mkdtempSync(join(tmpdir(), "tovi-browser-skip-tests-"));
  t.after(() => rmSync(testsRoot, { recursive: true, force: true }));
  writeFileSync(
    join(testsRoot, "runner-skipped-browser.test.mjs"),
    fixtureTest("SKIPPED_BROWSER_RAN", "// @tovi-browser\nconst SKIP_TEST = true;")
  );

  const rejected = run(process.execPath, [runnerPath, "browser"], testsRoot);
  assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /Required browser group skipped 1 test\(s\)/);

  const allowed = run(process.execPath, [runnerPath, "browser"], testsRoot, {
    TOVI_ALLOW_BROWSER_SKIPS: "1"
  });
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
});
