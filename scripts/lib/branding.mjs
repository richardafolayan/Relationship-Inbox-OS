import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env-file.mjs";

// Shared app display name for build/packaging scripts.
//
// The name is driven by the RIOS_APP_NAME environment variable so the whole
// product — including the packaged .app and DMG — can be rebranded from one
// place in .env. It reads process.env first, then the repo-root .env, then
// falls back to "Tovi".
//
// IMPORTANT: this is the display name only. The bundle identifier
// ("com.relationshipinboxos.*"), the Application Support storage folder and the
// logs folder deliberately keep the pre-rebrand identifiers so macOS TCC grants
// and existing installs' data keep working. Never derive those from this.

export const DEFAULT_APP_NAME = "Tovi";

// The original, pre-rebrand product name. Used only to name the old install
// when telling users to remove it. Never rebranded.
export const LEGACY_APP_NAME = "Relationship Inbox OS";

const APP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function envFileAppName() {
  try {
    return readEnvFile(join(REPO_ROOT, ".env")).RIOS_APP_NAME ?? "";
  } catch {
    return "";
  }
}

export function resolveAppName(env = process.env) {
  const raw = (env.RIOS_APP_NAME ?? "").trim() || (env === process.env ? envFileAppName().trim() : "");
  const value = raw || DEFAULT_APP_NAME;
  if (!APP_NAME_PATTERN.test(value)) {
    throw new Error(
      "RIOS_APP_NAME must be 1-80 letters, numbers, spaces, dots, underscores, parentheses or hyphens."
    );
  }
  return value;
}
