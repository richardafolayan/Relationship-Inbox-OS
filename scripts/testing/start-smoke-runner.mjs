import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = resolve(
  process.env.TOVI_SMOKE_DATABASE ?? "/tmp/tovi-smoke-performance-e2e.sqlite"
);
const dataDir = resolve(process.env.TOVI_SMOKE_DATA_DIR ?? "/tmp/tovi-smoke-e2e-data");

if (!basename(databasePath).startsWith("tovi-smoke-") || !basename(dataDir).startsWith("tovi-smoke-")) {
  throw new Error("Smoke data paths must use the tovi-smoke- prefix");
}
if (!/(perf|benchmark)/i.test(databasePath)) {
  throw new Error("Smoke database path must identify an isolated performance fixture");
}

await Promise.all([
  rm(databasePath, { force: true }),
  rm(`${databasePath}-wal`, { force: true }),
  rm(`${databasePath}-shm`, { force: true }),
  rm(dataDir, { recursive: true, force: true })
]);
await mkdir(dataDir, { recursive: true });

const databaseUrl = `file:${databasePath}`;
const baseEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  RIOS_DATA_DIR: dataDir
};

function run(label, args, env = baseEnv) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

run("Prisma schema setup", [
  "node_modules/prisma/build/index.js",
  "db",
  "push",
  "--schema",
  "packages/core/prisma/schema.prisma",
  "--skip-generate"
]);
run(
  "Smoke fixture seed",
  ["scripts/performance/seed-interaction-fixture.mjs"],
  { ...baseEnv, PERF_THREADS: "80", PERF_MESSAGES_PER_THREAD: "20" }
);
run("Smoke setup state seed", ["scripts/testing/seed-smoke-setup-state.mjs"]);

const runner = spawn(process.execPath, ["apps/runner/dist/index.js"], {
  cwd: repoRoot,
  env: {
    ...baseEnv,
    RUNNER_HOST: "127.0.0.1",
    RUNNER_PORT: process.env.RUNNER_PORT ?? "4311",
    LINKEDIN_DEV_DISABLE_AUTOSCAN: "true",
    CONTACTS_BIRTHDAY_SYNC: "false",
    IMESSAGE_ENABLED: "false",
    WHATSAPP_ENABLED: "false",
    GOOGLE_MESSAGES_ENABLED: "false",
    OPENAI_API_KEY: "",
    Z_AI_API_KEY: "",
    GEMINI_API_KEY: "",
    AUDIO_TRANSCRIPTION_ENABLED: "false",
    ENRICH_AUTO_ENABLED: "false"
  },
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => runner.kill(signal));
}

runner.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
