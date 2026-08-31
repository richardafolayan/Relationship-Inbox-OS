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
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planNpmInvocation } from "../scripts/testing/npm-invocation.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repoRoot, "scripts/testing/run-tests.mjs");
const browserPolicyPath = join(repoRoot, "scripts/testing/browser-fixture-policy.mjs");
const npmInvocationPath = join(repoRoot, "scripts/testing/npm-invocation.mjs");
const preparationLeasePath = join(
  repoRoot,
  "scripts/testing/repository-preparation-lease.mjs"
);

function directoryLinkTypeForPlatform(platform) {
  return platform === "win32" ? "junction" : "dir";
}

const directoryLinkType = directoryLinkTypeForPlatform(process.platform);

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

function createCleanEntrypointRepo(
  t,
  { includeCleanTests = true, detectConcurrentPreparation = false } = {}
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tovi-clean-entrypoints-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  mkdirSync(join(fixtureRoot, "scripts/testing"), { recursive: true });
  copyFileSync(runnerPath, join(fixtureRoot, "scripts/testing/run-tests.mjs"));
  copyFileSync(
    browserPolicyPath,
    join(fixtureRoot, "scripts/testing/browser-fixture-policy.mjs")
  );
  copyFileSync(
    npmInvocationPath,
    join(fixtureRoot, "scripts/testing/npm-invocation.mjs")
  );
  copyFileSync(
    preparationLeasePath,
    join(fixtureRoot, "scripts/testing/repository-preparation-lease.mjs")
  );
  symlinkSync(
    join(repoRoot, "node_modules"),
    join(fixtureRoot, "node_modules"),
    directoryLinkType
  );

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
    `import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
${detectConcurrentPreparation ? `const activePath = join(root, ".fixture-preparation-active");
let activeHandle;
try {
  activeHandle = openSync(activePath, "wx");
} catch {
  process.stderr.write("CONCURRENT_PREPARATION_DETECTED\\n");
  process.exit(23);
}
appendFileSync(join(root, ".fixture-preparation-log"), \`start \${process.pid} \${target}\\n\`);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));` : ""}
if (target === "core" || target === "runner") {
  const dist = target === "core" ? "packages/core/dist" : "apps/runner/dist";
  const distPath = join(root, dist);
  mkdirSync(distPath, { recursive: true });
  writeFileSync(join(distPath, "marker.mjs"), \`export const marker = "\${target.toUpperCase()}_BUILD_READY";\\n\`);
}
${detectConcurrentPreparation ? `appendFileSync(join(root, ".fixture-preparation-log"), \`end \${process.pid} \${target}\\n\`);
closeSync(activeHandle);
rmSync(activePath, { force: true });` : ""}
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
  const invocation = planNpmInvocation(process.platform, args, env);
  return spawnSync(invocation.command, invocation.args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024
  });
}

function runCleanEntrypointAsync(fixtureRoot, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TOVI_TESTS_ROOT;
  const invocation = planNpmInvocation(process.platform, args, env);
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: fixtureRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolveResult({ status, signal, stdout, stderr });
    });
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

test("clean entrypoint fixtures use portable directory links", () => {
  assert.equal(directoryLinkTypeForPlatform("win32"), "junction");
  assert.equal(directoryLinkTypeForPlatform("linux"), "dir");
});

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

test("concurrent entrypoints serialize repository artifact preparation", async (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t, {
    detectConcurrentPreparation: true
  });
  const [first, second] = await Promise.all([
    runCleanEntrypointAsync(fixtureRoot, ["run", "test:unit"]),
    runCleanEntrypointAsync(fixtureRoot, ["run", "test:unit"])
  ]);

  for (const result of [first, second]) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /CONCURRENT_PREPARATION_DETECTED/);
  }

  const events = readFileSync(
    join(fixtureRoot, ".fixture-preparation-log"),
    "utf8"
  ).trim().split("\n");
  let active = 0;
  let maximumActive = 0;
  for (const event of events) {
    active += event.startsWith("start ") ? 1 : -1;
    maximumActive = Math.max(maximumActive, active);
  }
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test("stale lease recovery keeps three contenders mutually exclusive", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tovi-stale-lease-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const leaseSource = readFileSync(preparationLeasePath, "utf8").replace(
    'from "node:fs/promises"',
    'from "./barrier-fs.mjs"'
  );
  writeFileSync(join(fixtureRoot, "repository-preparation-lease.mjs"), leaseSource);
  writeFileSync(
    join(fixtureRoot, "barrier-fs.mjs"),
    `import * as real from "node:fs/promises";

export const mkdir = real.mkdir;
export const readdir = real.readdir;
export const rm = real.rm;
export const rmdir = real.rmdir;
export const writeFile = real.writeFile;

let staleOwnerReads = 0;
let releaseStaleReaders;
const staleReadersReady = new Promise((resolve) => {
  releaseStaleReaders = resolve;
});
let abandonedRenameCalls = 0;
let releaseDelayedRenames;
const firstReplacementAcquired = new Promise((resolve) => {
  releaseDelayedRenames = resolve;
});

function normalized(path) {
  return String(path).replaceAll("\\\\", "/");
}

export async function readFile(path, ...args) {
  const value = await real.readFile(path, ...args);
  if (
    normalized(path).endsWith("/.tovi-test-preparation.lock/owner.json") &&
    String(value).includes('"token":"stale"')
  ) {
    staleOwnerReads += 1;
    if (staleOwnerReads === 3) releaseStaleReaders();
    await staleReadersReady;
  }
  return value;
}

export async function rename(from, to) {
  const source = normalized(from);
  const destination = normalized(to);
  if (
    source.endsWith("/.tovi-test-preparation.lock") &&
    destination.includes("/.tovi-test-preparation.lock.abandoned-")
  ) {
    abandonedRenameCalls += 1;
    if (abandonedRenameCalls > 1) await firstReplacementAcquired;
  }
  const result = await real.rename(from, to);
  if (
    staleOwnerReads === 3 &&
    source.includes("/.tovi-test-preparation.lock.candidate-") &&
    destination.endsWith("/.tovi-test-preparation.lock")
  ) {
    releaseDelayedRenames();
  }
  return result;
}
`
  );

  const lockPath = join(fixtureRoot, ".tovi-test-preparation.lock");
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "stale" })
  );

  const { acquireRepositoryPreparationLease } = await import(
    `${pathToFileURL(join(fixtureRoot, "repository-preparation-lease.mjs")).href}?test=${Date.now()}`
  );
  let active = 0;
  let maximumActive = 0;
  const contender = async () => {
    const release = await acquireRepositoryPreparationLease(fixtureRoot, {
      pollMilliseconds: 1,
      timeoutMilliseconds: 5_000
    });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    active -= 1;
    await release();
  };

  await Promise.all([contender(), contender(), contender()]);

  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test("stale lease recovery survives an orphaned reclaim coordinator", async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "tovi-orphaned-reclaim-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const lockPath = join(fixtureRoot, ".tovi-test-preparation.lock");
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "stale" })
  );
  const reclaimPath = `${lockPath}.reclaim`;
  mkdirSync(reclaimPath);
  writeFileSync(
    join(reclaimPath, "owner-orphaned.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "orphaned" })
  );

  const { acquireRepositoryPreparationLease } = await import(
    `${pathToFileURL(preparationLeasePath).href}?test=${Date.now()}`
  );
  let active = 0;
  let maximumActive = 0;
  const contender = async () => {
    const release = await acquireRepositoryPreparationLease(fixtureRoot, {
      pollMilliseconds: 1,
      timeoutMilliseconds: 1_000
    });
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    active -= 1;
    await release();
  };

  await Promise.all([contender(), contender(), contender()]);

  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
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

test("browser group excludes fixtures scoped to another platform", (t) => {
  const fixtureRoot = createCleanEntrypointRepo(t, { includeCleanTests: false });
  const testsRoot = join(fixtureRoot, "tests");
  const otherPlatform = process.platform === "linux" ? "darwin" : "linux";
  writeFileSync(
    join(testsRoot, "dashboard-applicable-browser.test.mjs"),
    fixtureTest("APPLICABLE_BROWSER_RAN", "// @tovi-browser")
  );
  writeFileSync(
    join(testsRoot, "dashboard-other-platform-browser.test.mjs"),
    fixtureTest(
      "OTHER_PLATFORM_BROWSER_RAN",
      `// @tovi-browser\n// @tovi-browser-platform ${otherPlatform}\nconst SKIP_TEST = true;`
    )
  );

  const result = runSyntheticGroup(fixtureRoot, "browser");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /APPLICABLE_BROWSER_RAN/);
  assert.doesNotMatch(result.stdout, /OTHER_PLATFORM_BROWSER_RAN/);
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
