import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const coldSamples = Number(args.get("--cold-samples") ?? 0);
const warmSamples = Number(args.get("--warm-samples") ?? 20);
const outputPath = args.get("--output");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarise(values) {
  if (values.length === 0) return null;
  return {
    samples: values.length,
    p50_ms: Number(percentile(values, 0.5).toFixed(2)),
    p95_ms: Number(percentile(values, 0.95).toFixed(2)),
    min_ms: Number(Math.min(...values).toFixed(2)),
    max_ms: Number(Math.max(...values).toFixed(2))
  };
}

function measure(iterations, forceRebuild) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, ["scripts/start-app.mjs", "--prepare-only"], {
      cwd: root,
      env: { ...process.env, RIOS_REBUILD: forceRebuild ? "1" : "0" },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "Launcher preparation failed");
    }
    values.push(performance.now() - startedAt);
  }
  return values;
}

const cold = measure(coldSamples, true);
const warm = measure(warmSamples, false);
const output = {
  generated_at: new Date().toISOString(),
  definition: {
    cold: "RIOS_REBUILD=1 prepare-only launch, including schema/client/core/dashboard preparation",
    warm: "prepare-only launch with unchanged inputs and valid preparation stamps"
  },
  summary: {
    launcher_cold_prepare_ms: summarise(cold),
    launcher_warm_prepare_ms: summarise(warm)
  },
  raw: { launcher_cold_prepare_ms: cold, launcher_warm_prepare_ms: warm }
};
const rendered = JSON.stringify(output, null, 2) + "\n";
if (outputPath) await writeFile(outputPath, rendered);
process.stdout.write(rendered);
