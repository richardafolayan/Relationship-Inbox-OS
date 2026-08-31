// @tovi-browser
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createCleanEntrypointRepo(t, { includeCleanTests = true } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tovi-clean-entrypoints-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  mkdirSync(join(fixtureRoot, "scripts/testing"), { recursive: true });
  copyFileSync(runnerPath, join(fixtureRoot, "scripts/testing/run-tests.mjs"));
  symlinkSync(join(repoRoot, "node_modules"), join(fixtureRoot, "node_modules"), "dir");

  const rootScripts = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ).scripts;
  const dashboardScripts = JSON.parse(
    readFileSync(join(repoRoot, "apps/dashboard/package.json"), "utf8")
  ).scripts;
  const runnerScripts = JSON.parse(
    readFileSync(join(repoRoot, "apps/runner/package.json"), "utf8")
  ).scripts;
  const coreScripts = JSON.parse(
    readFileSync(join(repoRoot, "packages/core/package.json"), "utf8")
  ).scripts;

  writeJson(join(fixtureRoot, "package.json"), {
    name: "tovi-clean-entrypoint-fixture",
    private: true,
    workspaces: ["apps/*", "packages/*"],
    scripts: {
      test: rootScripts.test,
      "test:all": rootScripts["test:all"],
      "test:unit": rootScripts["test:unit"],
      "test:browser:fixtures": rootScripts["test:browser:fixtures"],
      "db:generate": "node scripts/fake-build.mjs db"
    }
  });
  writeJson(join(fixtureRoot, "apps/dashboard/package.json"), {
    name: "@inbox-os/dashboard",
    private: true,
    scripts: { test: dashboardScripts.test }
  });
  writeJson(join(fixtureRoot, "apps/runner/package.json"), {
    name: "@inbox-os/runner",
    private: true,
    scripts: {
      build: "node ../../scripts/fake-build.mjs runner",
      test: runnerScripts.test
    }
  });
  writeJson(join(fixtureRoot, "packages/core/package.json"), {
    name: "@inbox-os/core",
    private: true,
    scripts: {
      build: "node ../../scripts/fake-build.mjs core",
      test: coreScripts.test
    }
  });
  writeFileSync(
    join(fixtureRoot, "scripts/fake-build.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (target === "core" || target === "runner") {
  const dist = target === "core" ? "packages/core/dist" : "apps/runner/dist";
  const distPath = join(root, dist);
  mkdirSync(distPath, { recursive: true });
  writeFileSync(join(distPath, "marker.mjs"), \`export const marker = "\${target.toUpperCase()}_BUILD_READY";\\n\`);
}
console.log(\`FAKE_BUILD_\${target.toUpperCase()}\`);
`
  );

  const testsRoot = join(fixtureRoot, "tests");
  mkdirSync(testsRoot, { recursive: true });
  if (!includeCleanTests) return fixtureRoot;

  const imports = `import { marker as core } from "../packages/core/dist/marker.mjs";
import { marker as runner } from "../apps/runner/dist/marker.mjs";`;
  writeFileSync(
    join(testsRoot, "dashboard-clean-unit.test.mjs"),
    `import assert from "node:assert/strict";
import test from "node:test";
${imports}
test("clean unit entrypoint", () => {
  assert.equal(core, "CORE_BUILD_READY");
  assert.equal(runner, "RUNNER_BUILD_READY");
});
`
  );
  writeFileSync(
    join(testsRoot, "dashboard-clean-browser.test.mjs"),
    `// @tovi-browser
import assert from "node:assert/strict";
import test from "node:test";
${imports}
test("clean browser entrypoint", () => {
  assert.equal(core, "CORE_BUILD_READY");
  assert.equal(runner, "RUNNER_BUILD_READY");
});
`
  );
  writeFileSync(
    join(testsRoot, "runner-entrypoint.test.mjs"),
    `import assert from "node:assert/strict";
import test from "node:test";
${imports}
test("runner entrypoint", () => {
  assert.equal(core, "CORE_BUILD_READY");
  assert.equal(runner, "RUNNER_BUILD_READY");
  console.log("RUNNER_ENTRYPOINT_RAN");
});
`
  );
  writeFileSync(
    join(testsRoot, "core-entrypoint.test.mjs"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { marker as core } from "../packages/core/dist/marker.mjs";
test("core entrypoint", () => {
  assert.equal(core, "CORE_BUILD_READY");
  console.log("CORE_ENTRYPOINT_RAN");
});
`
  );

  return fixtureRoot;
}

function runCleanEntrypoint(fixtureRoot, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TOVI_TESTS_ROOT;
  return spawnSync("npm", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024
  });
}

function runSyntheticGroup(fixtureRoot, group, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  delete env.TOVI_TESTS_ROOT;
  return spawnSync(
    process.execPath,
    [join(fixtureRoot, "scripts/testing/run-tests.mjs"), group],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env,
      maxBuffer: 20 * 1024 * 1024
    }
  );
}

test("workspace test commands execute their real matching child tests", (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t);

  const cases = [
    ["@inbox-os/dashboard", "clean unit entrypoint"],
    ["@inbox-os/runner", "RUNNER_ENTRYPOINT_RAN"],
    ["@inbox-os/core", "CORE_ENTRYPOINT_RAN"]
  ];
  for (const [workspace, marker] of cases) {
    const result = runCleanEntrypoint(fixtureRoot, [
      "test",
      "--workspace",
      workspace
    ]);
    assert.equal(
      result.status,
      0,
      `${workspace} failed:\n${result.stdout}\n${result.stderr}`
    );
    assert.match(result.stdout, new RegExp(marker));
  }
});

test("every direct root and dashboard entrypoint builds clean core and runner artifacts", (t) => {
  const cases = [
    ["npm test", ["test"]],
    ["test:all", ["run", "test:all"]],
    ["test:unit", ["run", "test:unit"]],
    ["test:browser:fixtures", ["run", "test:browser:fixtures"]],
    ["dashboard workspace", ["test", "--workspace", "@inbox-os/dashboard"]]
  ];

  for (const [label, args] of cases) {
    const fixtureRoot = createCleanEntrypointRepo(t);
    const result = runCleanEntrypoint(fixtureRoot, args);
    assert.equal(
      result.status,
      0,
      `${label} failed from a clean tree:\n${result.stdout}\n${result.stderr}`
    );
    assert.match(result.stdout, /FAKE_BUILD_CORE/);
    assert.match(result.stdout, /FAKE_BUILD_RUNNER/);
  }
});

test("browser group includes explicit browser fixtures and runs them serially", (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t, { includeCleanTests: false });
  const testsRoot = join(fixtureRoot, "tests");
  writeFileSync(
    join(testsRoot, "dashboard-browser-entrypoint.test.mjs"),
    fixtureTest("BROWSER_ENTRYPOINT_RAN", "// @tovi-browser")
  );

  const result = runSyntheticGroup(fixtureRoot, "browser");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BROWSER_ENTRYPOINT_RAN/);
  assert.match(result.stdout, /browser: 1 file\(s\), concurrency 1/);
});

test("required browser skips fail closed unless the override is explicit", (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t, { includeCleanTests: false });
  const testsRoot = join(fixtureRoot, "tests");
  writeFileSync(
    join(testsRoot, "runner-skipped-browser.test.mjs"),
    fixtureTest("SKIPPED_BROWSER_RAN", "// @tovi-browser\nconst SKIP_TEST = true;")
  );

  const rejected = runSyntheticGroup(fixtureRoot, "browser");
  assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /Required browser group skipped 1 test\(s\)/);

  const allowed = runSyntheticGroup(fixtureRoot, "browser", {
    TOVI_ALLOW_BROWSER_SKIPS: "1"
  });
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
});

test("Electron browser fixtures are required and their skips fail closed", (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t, { includeCleanTests: false });
  const testsRoot = join(fixtureRoot, "tests");
  writeFileSync(
    join(testsRoot, "dashboard-electron-browser.test.mjs"),
    fixtureTest(
      "SKIPPED_ELECTRON_BROWSER_RAN",
      'import electronPath from "electron";\nconst SKIP_TEST = Boolean(electronPath);'
    )
  );

  const rejected = runSyntheticGroup(fixtureRoot, "browser");
  assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /Required browser group skipped 1 test\(s\)/);
});
