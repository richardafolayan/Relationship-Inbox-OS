import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// First-run setup: save a Gemini API key from the dashboard (#845).
//
// The runner reads GEMINI_API_KEY from .env once at boot (config.ts), and
// until now the only way for a pilot to set it was hand-editing .env and
// restarting — the exact cliff pilot R-0109 flagged. This service gives the
// setup wizard a safe write path:
//
//   validate (live, against the Gemini endpoint) → persist (atomic
//   parse-and-update of the .env the runner actually reads) → apply
//   (mutate runnerConfig + process.env so the lazily built AI client
//   picks the key up on the next call, no restart).
//
// The key value must never be logged; errors carry calm operator-facing
// messages only.

/** Loose shape check before any network call. Google API keys are 30-50ish
 * URL-safe chars, but we only reject obvious paste accidents (spaces,
 * newlines, quotes, too short) — the live validation is the real gate. */
export function isPlausibleApiKeyShape(key: string): boolean {
  return /^[A-Za-z0-9_.-]{20,200}$/.test(key);
}

/**
 * Pure parse-and-update of .env content. Replaces the value on the first
 * non-comment `KEY=...` line (preserving every other line, comments and
 * unrelated keys byte-for-byte), or appends `KEY=value` at the end. Always
 * returns content ending in a single trailing newline.
 */
export function upsertEnvContent(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = content.split("\n");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const next = lines.map((existing) => {
    if (!replaced && pattern.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    // Drop trailing blank lines before appending so the file stays tidy.
    while (next.length > 0 && next[next.length - 1]!.trim() === "") next.pop();
    next.push(line);
  }
  let out = next.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * The .env file the wizard should write. Mirrors the read order in
 * config.ts: the packaged app sets RIOS_CONFIG_DIR and its .env wins
 * (dotenv loads it first and does not override); dev reads cwd/.env.
 */
export function resolveEnvWritePath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.RIOS_CONFIG_DIR?.trim();
  if (configDir) return resolve(configDir, ".env");
  return resolve(process.cwd(), ".env");
}

/** Atomic upsert of one env var: read (or start empty), update, write to a
 * temp sibling, rename over the original. Never clobbers other keys. */
export function upsertEnvFile(filePath: string, key: string, value: string): void {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const next = upsertEnvContent(current, key, value);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, next, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, filePath);
}

export interface GeminiKeyCheck {
  ok: boolean;
  /** Calm operator-facing message on failure. Never contains the key. */
  message?: string;
}

/**
 * Live-validate a Gemini API key with a cheap authenticated GET against the
 * OpenAI-compat models listing. 401/403 means the key is wrong; network
 * failures are reported as "couldn't reach", distinct from a bad key.
 */
export async function validateGeminiKey(
  key: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<GeminiKeyCheck> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    return {
      ok: false,
      message: "Couldn't reach Google to check the key. Check your internet connection and try again."
    };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    return {
      ok: false,
      message: "Google didn't accept that key. Copy it again from aistudio.google.com/apikey and paste the whole thing."
    };
  }
  return {
    ok: false,
    message: "Google returned an unexpected error while checking the key. Try again in a minute."
  };
}

export interface ApplyGeminiKeyDeps {
  validate: (key: string) => Promise<GeminiKeyCheck>;
  persist: (key: string) => void;
  /** Applies the key to the live process (runnerConfig + process.env). */
  applyRuntime: (key: string) => void;
}

export type ApplyGeminiKeyResult =
  | { ok: true }
  | { ok: false; status: 400 | 502; message: string };

/** Orchestrates the save: shape check → live validation → persist → apply. */
export async function applyGeminiKey(
  rawKey: unknown,
  deps: ApplyGeminiKeyDeps
): Promise<ApplyGeminiKeyResult> {
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key || !isPlausibleApiKeyShape(key)) {
    return {
      ok: false,
      status: 400,
      message: "That doesn't look like an API key. Paste the whole key from aistudio.google.com/apikey."
    };
  }
  const check = await deps.validate(key);
  if (!check.ok) {
    return { ok: false, status: 400, message: check.message ?? "The key didn't validate." };
  }
  try {
    deps.persist(key);
  } catch {
    return {
      ok: false,
      status: 502,
      message: "The key checked out but couldn't be saved. Try again, or set GEMINI_API_KEY in .env by hand."
    };
  }
  deps.applyRuntime(key);
  return { ok: true };
}
