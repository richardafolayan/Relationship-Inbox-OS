import { existsSync, readFileSync } from "node:fs";

/**
 * Resolves phone numbers / emails to display names by reading a vCard 3.0
 * export of the operator's address book. Used by the iMessage adapter so
 * chat.db threads come back with real names instead of phone numbers.
 *
 * Privacy: the vcf path is read locally; we never log handle→name pairs.
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

interface VcardEntry {
  name: string;
  phones: string[];
  emails: string[];
}

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

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  // Match on the trailing 10 digits — handles UK mobiles in any of:
  // "+447xxxxxxxxx", "07xxxxxxxxx", "447xxxxxxxxx", "07xxx xxx xxx".
  return digits.slice(-10);
}

function normalizeEmail(raw: string): string | null {
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

export function loadContactResolver(vcfPath: string | undefined): ContactResolver {
  if (!vcfPath || !existsSync(vcfPath)) return NULL_RESOLVER;
  let raw: string;
  try {
    raw = readFileSync(vcfPath, "utf8");
  } catch {
    return NULL_RESOLVER;
  }
  const entries = parseVcardEntries(raw);
  const phoneMap = new Map<string, string>();
  const emailMap = new Map<string, string>();
  // name → entry, for siblingHandles(). Last-wins on name collision matches
  // the resolve() last-wins semantics.
  const entryByName = new Map<string, VcardEntry>();
  for (const entry of entries) {
    for (const phone of entry.phones) {
      const key = normalizePhone(phone);
      if (key) phoneMap.set(key, entry.name);
    }
    for (const email of entry.emails) {
      const key = normalizeEmail(email);
      if (key) emailMap.set(key, entry.name);
    }
    entryByName.set(entry.name, entry);
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
      const name = resolveName(handle);
      if (!name) return [handle];
      const entry = entryByName.get(name);
      if (!entry) return [handle];
      return [...entry.phones, ...entry.emails];
    },
    size(): number {
      return phoneMap.size + emailMap.size;
    }
  };
}
