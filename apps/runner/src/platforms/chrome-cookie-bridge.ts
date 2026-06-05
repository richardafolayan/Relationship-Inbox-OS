import { execFileSync } from "node:child_process";
import { createHash, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/**
 * Why this exists:
 *
 * On macOS, Chrome encrypts every cookie value (including LinkedIn's
 * li_at auth cookie) with AES-128-CBC. The key is derived from a random
 * password stored in the login Keychain as the generic-password item
 * "Chrome Safe Storage". When Playwright/Patchright launches Chrome with
 * a custom --user-data-dir, the launched browser frequently cannot get
 * transparent Keychain access to that item (the prompt is suppressed or
 * denied in an automation context), so it falls back to an empty key and
 * can no longer decrypt the cookies copied from the user's real profile.
 * The result: LinkedIn drops to the login page on every launch even
 * though a perfectly valid session exists in the source profile.
 *
 * The runner process itself DOES run as the user with the login Keychain
 * unlocked, so it can read "Chrome Safe Storage", derive the key, decrypt
 * the LinkedIn auth cookies straight out of the source profile's Cookies
 * SQLite, and inject them into the launched browser context via
 * Playwright addCookies(). That sidesteps Chrome's fragile profile-cookie
 * decryption entirely and is deterministic across restarts.
 *
 * Secrets stay on-device: the Keychain password and decrypted cookie
 * values are held in memory only, never logged, never transmitted.
 */

/** Playwright's addCookies() cookie shape (structural — avoids a hard type import). */
export interface BridgeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface AddCookiesCapable {
  addCookies(cookies: BridgeCookie[]): Promise<void>;
}

export interface ChromeCookieBridgeOptions {
  /** Chrome user-data-dir root, e.g. ~/Library/Application Support/Google/Chrome */
  sourceUserDataDir: string;
  /** Profile directory name within the user-data-dir, e.g. "Default". */
  profileDirectory: string;
  /**
   * Keychain account for the "Chrome Safe Storage" item. "Chrome" for
   * stable Google Chrome, "Chromium" for Chromium builds. Default "Chrome".
   */
  keychainAccount?: string;
}

export interface CookieSyncResult {
  injected: number;
  /** Machine-readable status for logging/diagnostics. Never contains secrets. */
  reason:
    | "ok"
    | "keychain_unavailable"
    | "cookie_db_missing"
    | "no_matching_cookies"
    | "decrypt_failed"
    | "error";
  /** Human-readable detail safe to log (no secrets). */
  detail?: string;
  /** Cookie names that were injected (names are not secret; values are never logged). */
  names?: string[];
}

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
// Chrome's macOS v10 IV is 16 bytes of ASCII space (0x20).
const IV = Buffer.alloc(16, " ");
// Microseconds between 1601-01-01 (Chrome epoch) and 1970-01-01 (Unix epoch).
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

interface RawCookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer | null;
  value: string | null;
  path: string | null;
  is_secure: number;
  is_httponly: number;
  expires_utc: number;
  samesite: number;
}

export class ChromeCookieBridge {
  private readonly sourceUserDataDir: string;
  private readonly profileDirectory: string;
  private readonly keychainAccount: string;
  /** Derived AES key, cached for the process lifetime (it never changes). */
  private cachedKey: Buffer | null = null;

  constructor(options: ChromeCookieBridgeOptions) {
    this.sourceUserDataDir = options.sourceUserDataDir;
    this.profileDirectory = options.profileDirectory;
    this.keychainAccount = options.keychainAccount ?? "Chrome";
  }

  /**
   * Read the LinkedIn auth cookies from the source Chrome profile, decrypt
   * them with the macOS Keychain key, and inject them into the given
   * Playwright BrowserContext. Best-effort: returns a structured result and
   * never throws, so a cookie-sync hiccup can't block a scan/send.
   */
  async syncIntoContext(
    context: AddCookiesCapable,
    hostFilterLike = "%linkedin.com%"
  ): Promise<CookieSyncResult> {
    let key: Buffer;
    try {
      key = this.getSafeStorageKey();
    } catch (error) {
      return {
        injected: 0,
        reason: "keychain_unavailable",
        detail:
          `Could not read the "Chrome Safe Storage" Keychain item ` +
          `(account "${this.keychainAccount}"). If a macOS prompt appeared, ` +
          `click "Always Allow". Underlying: ${errMessage(error)}`
      };
    }

    const dbPath = this.resolveCookieDbPath();
    if (!dbPath) {
      return {
        injected: 0,
        reason: "cookie_db_missing",
        detail: `No Cookies database under ${resolve(
          this.sourceUserDataDir,
          this.profileDirectory
        )} (looked for Network/Cookies and Cookies).`
      };
    }

    let rows: RawCookieRow[];
    try {
      rows = this.readCookieRows(dbPath, hostFilterLike);
    } catch (error) {
      return { injected: 0, reason: "error", detail: errMessage(error) };
    }

    if (rows.length === 0) {
      return { injected: 0, reason: "no_matching_cookies" };
    }

    const cookies: BridgeCookie[] = [];
    let decryptFailures = 0;
    for (const row of rows) {
      const value = this.resolveCookieValue(row, key);
      if (value === null || value.length === 0) {
        if (row.encrypted_value && row.encrypted_value.length > 0) {
          decryptFailures += 1;
        }
        continue;
      }
      const domain = row.host_key;
      const path = row.path && row.path.length > 0 ? row.path : "/";
      cookies.push({
        name: row.name,
        value,
        domain,
        path,
        expires:
          row.expires_utc > 0
            ? Math.floor(row.expires_utc / 1_000_000) - CHROME_EPOCH_OFFSET_SECONDS
            : -1,
        httpOnly: row.is_httponly === 1,
        secure: row.is_secure === 1,
        sameSite: mapSameSite(row.samesite)
      });
    }

    if (cookies.length === 0) {
      return {
        injected: 0,
        reason: decryptFailures > 0 ? "decrypt_failed" : "no_matching_cookies",
        detail:
          decryptFailures > 0
            ? `All ${decryptFailures} encrypted cookies failed to decrypt — ` +
              `likely a Keychain key mismatch (wrong account or a different ` +
              `Chrome channel encrypted them).`
            : undefined
      };
    }

    try {
      await context.addCookies(cookies);
    } catch (error) {
      return { injected: 0, reason: "error", detail: errMessage(error) };
    }

    return {
      injected: cookies.length,
      reason: "ok",
      names: cookies.map((c) => c.name)
    };
  }

  /** Read + PBKDF2-derive the AES key from the macOS Keychain. Cached. */
  private getSafeStorageKey(): Buffer {
    if (this.cachedKey) {
      return this.cachedKey;
    }
    const password = this.readKeychainPassword();
    const key = pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, "sha1");
    this.cachedKey = key;
    return key;
  }

  private readKeychainPassword(): string {
    // Kept synchronous and tightly scoped so the secret isn't held across
    // more async surface than necessary.
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-wa", this.keychainAccount, "-s", "Chrome Safe Storage"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const password = out.replace(/\n$/, "");
    if (!password) {
      throw new Error("empty Keychain password");
    }
    return password;
  }

  private resolveCookieDbPath(): string | null {
    const profileRoot = resolve(this.sourceUserDataDir, this.profileDirectory);
    const candidates = [join(profileRoot, "Network", "Cookies"), join(profileRoot, "Cookies")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  /**
   * Chrome keeps the Cookies DB open with WAL while running. Copy it (plus
   * any -wal/-shm sidecars) to a temp dir and open the copy read-only so we
   * never contend with the live browser or risk a partial read.
   */
  private readCookieRows(dbPath: string, hostFilterLike: string): RawCookieRow[] {
    const tempDir = mkdtempSync(join(tmpdir(), "inbox-os-cookies-"));
    const tempDb = join(tempDir, "Cookies");
    try {
      copyFileSync(dbPath, tempDb);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) {
          copyFileSync(sidecar, `${tempDb}${suffix}`);
        }
      }
      const db = new Database(tempDb, { readonly: true, fileMustExist: true });
      try {
        return db
          .prepare(
            `SELECT host_key, name, encrypted_value, value, path,
                    is_secure, is_httponly, expires_utc, samesite
             FROM cookies
             WHERE host_key LIKE ?`
          )
          .all(hostFilterLike) as RawCookieRow[];
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private resolveCookieValue(row: RawCookieRow, key: Buffer): string | null {
    const enc = row.encrypted_value;
    if (!enc || enc.length === 0) {
      // Legacy / unencrypted cookie — value column holds the plaintext.
      return row.value ?? null;
    }
    const prefix = enc.subarray(0, 3).toString("latin1");
    if (prefix !== "v10") {
      // v11 = Linux libsecret, v20 = Windows app-bound — not macOS Chrome.
      // Fall back to any plaintext value rather than guessing.
      return row.value && row.value.length > 0 ? row.value : null;
    }
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, IV);
      const decrypted = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
      // Chrome >=130 prepends SHA256(host_key) (32 bytes) to the plaintext
      // on all platforms. Strip it when present.
      if (decrypted.length >= 32) {
        const domainHash = createHash("sha256").update(row.host_key).digest();
        if (decrypted.subarray(0, 32).equals(domainHash)) {
          return decrypted.subarray(32).toString("utf8");
        }
      }
      return decrypted.toString("utf8");
    } catch {
      return null;
    }
  }
}

function mapSameSite(value: number): "Strict" | "Lax" | "None" {
  // Chrome cookies.samesite: -1 unspecified, 0 no_restriction, 1 lax, 2 strict.
  if (value === 2) return "Strict";
  if (value === 0) return "None";
  return "Lax";
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
