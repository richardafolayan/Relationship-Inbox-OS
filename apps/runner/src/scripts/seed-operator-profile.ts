/**
 * Seed the local operator profile from a personal seed file.
 *
 * Reads `operator-profile.seed.json` (next to the runner package.json;
 * gitignored — copy operator-profile.seed.example.json to create it) and
 * writes it into the `operator_profile_v1` Setting row, but ONLY when the
 * stored profile is still empty or a placeholder/test profile. A real
 * profile is left untouched unless `--force` is passed.
 *
 * This is a local/dev convenience. It keeps personal voice data out of
 * source control, and it never runs as part of normal app startup, so new
 * users always begin with a blank, neutral profile and set up their own.
 *
 *   npm run seed:operator-profile
 *   tsx src/scripts/seed-operator-profile.ts [--file <path>] [--force]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../db";
import { createSettingsStore } from "../services/settings";
import {
  classifyOperatorProfile,
  normaliseSeedProfile,
  shouldSeedOperatorProfile
} from "../services/operator-profile-seed";

const DEFAULT_SEED_FILENAME = "operator-profile.seed.json";

function resolveSeedFile(args: string[]): string {
  const flagIndex = args.indexOf("--file");
  if (flagIndex >= 0 && args[flagIndex + 1]) {
    return resolve(process.cwd(), args[flagIndex + 1]!);
  }
  if (process.env.OPERATOR_PROFILE_SEED_FILE) {
    return resolve(process.cwd(), process.env.OPERATOR_PROFILE_SEED_FILE);
  }
  return resolve(process.cwd(), DEFAULT_SEED_FILENAME);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const seedFile = resolveSeedFile(args);

  if (!existsSync(seedFile)) {
    console.log(
      `[seed-operator-profile] no seed file at ${seedFile} - nothing to do. ` +
        `Copy operator-profile.seed.example.json to ${DEFAULT_SEED_FILENAME} and fill it in.`
    );
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedFile, "utf8"));
  } catch (error) {
    console.error(`[seed-operator-profile] could not read or parse ${seedFile}:`, error);
    process.exitCode = 1;
    return;
  }

  const seed = normaliseSeedProfile(raw);
  if (!seed.displayName && !seed.about) {
    console.error(
      `[seed-operator-profile] ${seedFile} has no displayName or about - nothing to seed.`
    );
    process.exitCode = 1;
    return;
  }

  const store = createSettingsStore();
  const current = await store.getOperatorProfile();
  const currentClass = classifyOperatorProfile(current);

  if (!shouldSeedOperatorProfile(current, { force })) {
    console.log(
      `[seed-operator-profile] a real profile ("${current.displayName}") is already stored - ` +
        `left unchanged. Re-run with --force to overwrite it.`
    );
    return;
  }

  const saved = await store.updateOperatorProfile(seed);
  console.log(
    `[seed-operator-profile] seeded operator profile for "${saved.displayName}" ` +
      `(replaced a profile classified as "${currentClass}").`
  );
}

void main()
  .catch((error) => {
    console.error("[seed-operator-profile] failed", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
