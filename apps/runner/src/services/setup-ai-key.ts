import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import dotenv from "dotenv";

// First-run setup: save a Gemini API key from the dashboard (#845).
//
// The runner reads GEMINI_API_KEY from .env once at boot (config.ts), and
// until now the only way for a pilot to set it was hand-editing .env and
// restarting — the exact cliff pilot R-0109 flagged. This service gives the
// setup wizard a safe write path:
//
//   validate (live, against the Gemini endpoint) → stage outside the active
//   config → journal and promote atomically → commit the matching setup
//   transaction → apply to the live process. Startup uses the transaction id
//   to keep a committed promotion or roll back an interrupted one.
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

export interface StagedEnvFileValue {
  transactionId: string;
  commit(): void;
  rollback(): void;
  finalize(): void;
  discard(): void;
}

interface EnvFileValueTransactionJournal {
  transactionId: string;
  existed: boolean;
  backupName: string | null;
}

function transactionJournalPath(filePath: string): string {
  return `${filePath}.setup-key-transaction.json`;
}

function removeTransactionArtifacts(
  journalPath: string,
  pendingPath: string | null,
  backupPath: string | null
): void {
  if (pendingPath) rmSync(pendingPath, { force: true });
  if (backupPath) rmSync(backupPath, { force: true });
  rmSync(journalPath, { force: true });
}

export function stageEnvFileValue(
  filePath: string,
  key: string,
  value: string
): StagedEnvFileValue {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const next = upsertEnvContent(current, key, value);
  const transactionId = randomUUID();
  const tempPath = `${filePath}.${transactionId}.setup-key-pending`;
  const backupPath = `${filePath}.${transactionId}.setup-key-backup`;
  const journalPath = transactionJournalPath(filePath);
  writeFileSync(tempPath, next, { encoding: "utf8", mode: 0o600 });
  const existed = existsSync(filePath);
  let state: "pending" | "promoted" | "settled" = "pending";

  return {
    transactionId,
    commit: () => {
      if (state !== "pending") throw new Error("Staged environment value already settled.");
      if (existsSync(journalPath)) {
        throw new Error("Another setup key transaction still requires recovery.");
      }
      if (existed) {
        writeFileSync(backupPath, current, { encoding: "utf8", mode: 0o600 });
      }
      const journalTempPath = `${journalPath}.${transactionId}.tmp`;
      writeFileSync(
        journalTempPath,
        JSON.stringify({
          transactionId,
          existed,
          backupName: existed ? basename(backupPath) : null
        } satisfies EnvFileValueTransactionJournal),
        { encoding: "utf8", mode: 0o600 }
      );
      renameSync(journalTempPath, journalPath);
      renameSync(tempPath, filePath);
      state = "promoted";
    },
    rollback: () => {
      if (state !== "promoted") return;
      if (existed) {
        const rollbackPath = `${filePath}.${randomUUID()}.rollback`;
        writeFileSync(rollbackPath, current, { encoding: "utf8", mode: 0o600 });
        renameSync(rollbackPath, filePath);
      } else {
        rmSync(filePath, { force: true });
      }
      removeTransactionArtifacts(journalPath, tempPath, existed ? backupPath : null);
      state = "settled";
    },
    finalize: () => {
      if (state !== "promoted") throw new Error("Staged environment value was not promoted.");
      removeTransactionArtifacts(journalPath, tempPath, existed ? backupPath : null);
      state = "settled";
    },
    discard: () => {
      if (state !== "pending") return;
      if (existsSync(journalPath)) {
        recoverEnvFileValueTransaction(filePath, null);
      } else {
        rmSync(tempPath, { force: true });
        rmSync(backupPath, { force: true });
      }
      state = "settled";
    }
  };
}

export function recoverEnvFileValueTransaction(
  filePath: string,
  committedTransactionId: string | null | undefined
): "none" | "rolled_back" | "committed" {
  const journalPath = transactionJournalPath(filePath);
  if (!existsSync(journalPath)) return "none";
  let journal: EnvFileValueTransactionJournal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as EnvFileValueTransactionJournal;
  } catch {
    throw new Error("The setup key recovery journal is unreadable.");
  }
  const expectedBackupName =
    `${basename(filePath)}.${journal.transactionId}.setup-key-backup`;
  if (
    typeof journal.transactionId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
    typeof journal.existed !== "boolean" ||
    (journal.existed && journal.backupName !== expectedBackupName) ||
    (!journal.existed && journal.backupName !== null)
  ) {
    throw new Error("The setup key recovery journal is invalid.");
  }
  const parent = dirname(filePath);
  const backupPath = journal.backupName ? resolve(parent, journal.backupName) : null;
  if (journal.transactionId === committedTransactionId) {
    removeTransactionArtifacts(journalPath, null, backupPath);
    return "committed";
  }
  if (journal.existed) {
    if (!backupPath || !existsSync(backupPath)) {
      throw new Error("The setup key rollback backup is missing.");
    }
    renameSync(backupPath, filePath);
  } else {
    rmSync(filePath, { force: true });
  }
  removeTransactionArtifacts(journalPath, null, backupPath);
  return "rolled_back";
}

export function readEnvFileValue(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  return dotenv.parse(readFileSync(filePath, "utf8"))[key] || undefined;
}

export function discardStaleEnvFileStages(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) return;
  const prefix = `${basename(filePath)}.`;
  for (const name of readdirSync(parent)) {
    if (
      name.startsWith(prefix) &&
      (name.endsWith(".pending") ||
        name.endsWith(".setup-key-pending") ||
        name.endsWith(".setup-key-backup"))
    ) {
      rmSync(resolve(parent, name), { force: true });
    }
  }
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

export interface ApplyGeminiKeyDeps<TState> {
  validate: (key: string) => Promise<GeminiKeyCheck>;
  stage: (key: string) => StagedEnvFileValue;
  commitState: (transactionId: string) => Promise<TState>;
  applyRuntime: (key: string) => void;
}

export type ApplyGeminiKeyResult<TState> =
  | { ok: true; state: TState }
  | { ok: false; status: 400 | 502; message: string; state?: TState };

export async function applyGeminiKey<TState>(
  rawKey: unknown,
  deps: ApplyGeminiKeyDeps<TState>
): Promise<ApplyGeminiKeyResult<TState>> {
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
  let staged: StagedEnvFileValue;
  try {
    staged = deps.stage(key);
  } catch {
    return {
      ok: false,
      status: 502,
      message: "The key checked out but couldn't be saved. Quit and reopen Tovi, then run the setup assistant again. If it still fails, tell the person running the pilot."
    };
  }

  try {
    staged.commit();
  } catch {
    staged.discard();
    return {
      ok: false,
      status: 502,
      message: "The key checked out but couldn't be saved. Quit and reopen Tovi, then run the setup assistant again. If it still fails, tell the person running the pilot."
    };
  }

  let state: TState;
  try {
    state = await deps.commitState(staged.transactionId);
  } catch (error) {
    try {
      staged.rollback();
    } catch {
      // Startup recovery uses the uncommitted journal to finish this rollback.
    }
    throw error;
  }

  try {
    staged.finalize();
  } catch {
    // State and file are already committed. The matching journal lets startup
    // finish cleanup without turning a successful save into a false failure.
  }
  deps.applyRuntime(key);
  return { ok: true, state };
}
