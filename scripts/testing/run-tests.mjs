import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configuredTestsRoot = process.env.TOVI_TESTS_ROOT;
const testsRoot = configuredTestsRoot
  ? isAbsolute(configuredTestsRoot)
    ? configuredTestsRoot
    : resolve(repoRoot, configuredTestsRoot)
  : join(repoRoot, "tests");
const group = process.argv[2] ?? "all";
const allowedGroups = new Set(["all", "unit", "browser", "dashboard", "runner", "core"]);

if (!allowedGroups.has(group)) {
  throw new Error(`Unknown test group ${group}`);
}

const allFiles = readdirSync(testsRoot)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
const browserFiles = new Set();

for (const name of allFiles) {
  const source = await readFile(join(testsRoot, name), "utf8");
  if (
    /(?:^|\n)\s*\/\/\s*@tovi-browser\b/.test(source) ||
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:@playwright\/test|patchright|playwright|puppeteer)["']/.test(
      source
    )
  ) {
    browserFiles.add(name);
  }
}

const selected = allFiles.filter((name) => {
  if (group === "all") return true;
  if (group === "unit") return !browserFiles.has(name);
  if (group === "browser") return browserFiles.has(name);
  if (group === "dashboard") return name.startsWith("dashboard-") || name.startsWith("iphone-");
  if (group === "runner") return name.startsWith("runner-") || name.startsWith("student-");
  return name.startsWith("core-") || name === "prisma-command.test.mjs";
});

if (selected.length === 0) {
  throw new Error(`Test group ${group} resolved to zero files`);
}

const unitConcurrency = Number(process.env.TOVI_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(unitConcurrency) || unitConcurrency < 1) {
  throw new Error("TOVI_TEST_CONCURRENCY must be a positive integer");
}

function skippedTestCount(output) {
  const matches = [...output.matchAll(/# skipped\s+(\d+)/g)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

async function runPhase(label, names, concurrency, rejectSkips) {
  if (names.length === 0) return;
  process.stdout.write(`[tests] ${label}: ${names.length} file(s), concurrency ${concurrency}\n`);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      `--test-concurrency=${concurrency}`,
      ...names.map((name) => join(testsRoot, name))
    ],
    { cwd: repoRoot, env: childEnv, stdio: ["inherit", "pipe", "pipe"] }
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    process.exit(result.code ?? 1);
  }

  if (rejectSkips && process.env.TOVI_ALLOW_BROWSER_SKIPS !== "1") {
    const skipped = skippedTestCount(output);
    if (skipped > 0) {
      process.stderr.write(`Required browser group skipped ${skipped} test(s).\n`);
      process.exit(1);
    }
  }
}

const selectedUnitFiles = selected.filter((name) => !browserFiles.has(name));
const selectedBrowserFiles = selected.filter((name) => browserFiles.has(name));

await runPhase("unit", selectedUnitFiles, unitConcurrency, false);
await runPhase("browser", selectedBrowserFiles, 1, true);
