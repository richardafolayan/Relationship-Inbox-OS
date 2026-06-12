import { existsSync, readFileSync } from "node:fs";
import { readAllAddressBookContacts } from "../platforms/addressbook-db";

/**
 * Resolves phone numbers / emails to display names so chat.db threads come
 * back with real names instead of phone numbers.
 *
 * Two sources feed the resolver (see loadBestContactResolver):
 *   1. The live macOS Contacts (AddressBook) databases — read directly, the
 *      same way birthday-sync does, so names resolve on a fresh install with
 *      zero setup. This is the default and needs no manual export.
 *   2. An optional vCard 3.0 export at data/contacts.vcf — a manual override
 *      that wins on a handle collision, so a power user can correct names.
 *
 * Privacy: both sources are read locally; we never log handle→name pairs.
 * The data/ directory is gitignored so the operator's contacts stay on
 * their machine.
 *
 * Matching strategy:
 *   - Phone numbers are reduced to their last 10 digits (UK mobile length)
 *     so "+447700900123" / "07700900123" / "07700 900123" all match.
 *   - Emails are lowercased.
 *
 * If two contacts share a phone number, the last one parsed wins. The
 * operator can still confirm/edit via the dashboard pill.
 */

/** One contact: a display name plus its raw phone/email handles. */
export interface ContactEntry {
  name: string;
  phones: string[];
  emails: string[];
}

type VcardEntry = ContactEntry;

function unfoldVcardLines(raw: string): string[] {
  // vCard line folding: a line that starts with whitespace is a continuation
  // of the previous line. Reverse the fold before splitting.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      out[out.length - 1] = (out[out.length - 1] ?? "") + line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseVcardEntries(raw: string): VcardEntry[] {
  const lines = unfoldVcardLines(raw);
  const entries: VcardEntry[] = [];
  let current: VcardEntry | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VCARD") {
      current = { name: "", phones: [], emails: [] };
      continue;
    }
    if (line === "END:VCARD") {
      if (current && current.name) entries.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    // Property line: NAME[;PARAM=VALUE...]:VALUE
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1);
    const propName = head.split(";")[0] ?? "";

    if (propName === "FN") {
      current.name = value.trim();
    } else if (propName === "N" && !current.name) {
      // Fallback: N is "family;given;middle;prefix;suffix" — build a usable
      // name when FN is missing.
      const parts = value.split(";");
      const family = parts[0]?.trim() ?? "";
      const given = parts[1]?.trim() ?? "";
      const composed = [given, family].filter(Boolean).join(" ");
      if (composed) current.name = composed;
    } else if (propName === "TEL") {
      current.phones.push(value);
    } else if (propName === "EMAIL") {
      current.emails.push(value);
    }
  }
  return entries;
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  // Match on the trailing 10 digits — handles UK mobiles in any of:
  // "+447xxxxxxxxx", "07xxxxxxxxx", "447xxxxxxxxx", "07xxx xxx xxx".
  return digits.slice(-10);
}

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

export interface ContactResolver {
  /** Returns the resolved real name for a chat.db handle, or null when no contact matches. */
  resolve(handle: string): string | null;
  /**
   * Returns every handle (phones + emails, in their original vCard form)
   * for the contact that owns `handle`, including `handle` itself. Used by
   * the iMessage adapter to pick the iMessage-registered handle for a
   * recipient who has both an SMS phone and an iMessage email — without
   * this we'd send to whichever handle the chat row happened to be keyed
   * by, which is often the SMS one and silently routes via SMS.
   */
  siblingHandles(handle: string): string[];
  /** How many distinct contacts are loaded. Used for log lines / health surfaces. */
  size(): number;
}

const NULL_RESOLVER: ContactResolver = {
  resolve: () => null,
  siblingHandles: () => [],
  size: () => 0
};

/**
 * Parse a vCard file into entries, or return [] when the file is missing or
 * unreadable. Never throws — a bad vcf must degrade to "no names", never crash
 * a scan.
 */
export function loadVcardEntries(vcfPath: string | undefined): ContactEntry[] {
  if (!vcfPath || !existsSync(vcfPath)) return [];
  try {
    return parseVcardEntries(readFileSync(vcfPath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Read the live macOS Contacts databases into entries. macOS-only; returns []
 * off darwin or when Contacts is unreadable (no Full Disk Access) so the
 * caller degrades cleanly to the vCard (or to "no names"). Never throws.
 */
export function loadAddressBookEntries(options: {
  /** AddressBook DB paths; defaults to auto-discovery under $HOME. */
  dbPaths?: string[];
  /** Force-enable/disable the read. Defaults to macOS-only. */
  enabled?: boolean;
} = {}): ContactEntry[] {
  const enabled = options.enabled ?? process.platform === "darwin";
  if (!enabled) return [];
  try {
    return readAllAddressBookContacts(options.dbPaths).map((c) => ({
      name: c.name,
      phones: c.phones,
      emails: c.emails
    }));
  } catch {
    return [];
  }
}

export interface BestContactResolverOptions {
  /** Optional vCard 3.0 export path. Wins on a handle collision when present. */
  vcfPath?: string;
  /** AddressBook DB paths; defaults to auto-discovery under $HOME. */
  addressBookDbPaths?: string[];
  /** Force-enable/disable the AddressBook read. Defaults to macOS-only. */
  useAddressBook?: boolean;
}

/**
 * Build the resolver the runner actually uses: live macOS Contacts merged with
 * the optional manual vCard. The vCard is appended last so an explicit export
 * wins on a handle collision (last-wins, matching buildContactResolver), while
 * a fresh install with no vCard still resolves every name straight from the
 * Mac's address book.
 */
export function loadBestContactResolver(options: BestContactResolverOptions = {}): ContactResolver {
  const entries = [
    ...loadAddressBookEntries({
      dbPaths: options.addressBookDbPaths,
      enabled: options.useAddressBook
    }),
    // vCard last → manual override wins on collision.
    ...loadVcardEntries(options.vcfPath)
  ];
  return buildContactResolver(entries);
}

/**
 * Back-compat vCard-only loader. Prefer loadBestContactResolver, which also
 * reads the live macOS Contacts. Kept for callers/tests that pass an explicit
 * vcf path.
 */
export function loadContactResolver(vcfPath: string | undefined): ContactResolver {
  return buildContactResolver(loadVcardEntries(vcfPath));
}

/**
 * Build a ContactResolver from already-parsed entries. Pure (no I/O), so it is
 * the shared core behind every loader above and is trivially unit-testable.
 */
export function buildContactResolver(entries: ContactEntry[]): ContactResolver {
  if (entries.length === 0) return NULL_RESOLVER;
  const phoneMap = new Map<string, string>();
  const emailMap = new Map<string, string>();
  // handle key → owning entry index, for siblingHandles(). Keyed on entry
  // identity (its index in `entries`) rather than display name, so two
  // distinct contacts that share an FN don't cross-contaminate each other's
  // handle pools. Last-wins on handle-key collision matches resolve().
  const phoneEntryMap = new Map<string, number>();
  const emailEntryMap = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    for (const phone of entry.phones) {
      const key = normalizePhone(phone);
      if (key) {
        phoneMap.set(key, entry.name);
        phoneEntryMap.set(key, i);
      }
    }
    for (const email of entry.emails) {
      const key = normalizeEmail(email);
      if (key) {
        emailMap.set(key, entry.name);
        emailEntryMap.set(key, i);
      }
    }
  }
  function resolveName(handle: string): string | null {
    if (!handle) return null;
    const trimmed = handle.trim();
    if (trimmed.includes("@")) {
      return emailMap.get(trimmed.toLowerCase()) ?? null;
    }
    const key = normalizePhone(trimmed);
    return key ? phoneMap.get(key) ?? null : null;
  }
  return {
    resolve: resolveName,
    siblingHandles(handle: string): string[] {
      if (!handle) return [handle];
      const trimmed = handle.trim();
      const index = trimmed.includes("@")
        ? emailEntryMap.get(trimmed.toLowerCase())
        : (() => {
            const key = normalizePhone(trimmed);
            return key ? phoneEntryMap.get(key) : undefined;
          })();
      if (index === undefined) return [handle];
      const entry = entries[index];
      if (!entry) return [handle];
      return [...entry.phones, ...entry.emails];
    },
    size(): number {
      return phoneMap.size + emailMap.size;
    }
  };
}
