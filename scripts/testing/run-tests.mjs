import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testsRoot = join(repoRoot, "tests");
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
  if (/from ["']patchright["']|import\(["']patchright["']\)/.test(source)) {
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

const browserGroup = group === "browser";
const concurrency = browserGroup ? 1 : Number(process.env.TOVI_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("TOVI_TEST_CONCURRENCY must be a positive integer");
}

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    `--test-concurrency=${concurrency}`,
    ...selected.map((name) => join("tests", name))
  ],
  { cwd: repoRoot, env: process.env, stdio: ["inherit", "pipe", "pipe"] }
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

const exitCode = await new Promise((resolveExit) => child.once("exit", resolveExit));
if (exitCode !== 0) process.exit(exitCode ?? 1);

if (browserGroup && process.env.TOVI_ALLOW_BROWSER_SKIPS !== "1") {
  const skipped = Number(output.match(/# skipped\s+(\d+)/)?.[1] ?? 0);
  if (skipped > 0) {
    process.stderr.write(`Required browser group skipped ${skipped} test(s).\n`);
    process.exit(1);
  }
}
