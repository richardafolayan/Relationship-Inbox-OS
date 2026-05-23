import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";
import { runnerConfig } from "../config";
import { readAllAddressBookBirthdays } from "../platforms/addressbook-db";
import { IMessageDb } from "../platforms/imessage-db";
import { normalizeEmail, normalizePhone } from "./contact-resolver";

/**
 * Keeps Person.birthday / Person.birthYear in step with the operator's macOS
 * Contacts.
 *
 * The Person row stores no contact handle, so matching takes two routes:
 *   1. Unresolved iMessage contacts keep the raw phone/email as their
 *      displayName - it is normalized and matched directly.
 *   2. Resolved contacts (displayName is a real name) are bridged through
 *      chat.db: Thread.platformThreadId is the chat guid, and chat.db maps
 *      that guid to the conversation's participant handle.
 *
 * Read-only against both Contacts and chat.db, and idempotent against the
 * database (an unchanged birthday is skipped, so updatedAt is not churned).
 * Runs once at boot and then daily - Contacts data is near-static, and a
 * fresh sync on every runner restart keeps the lag low during development.
 */

interface BirthdaySyncDeps {
  /** Polling cadence in ms. Defaults to 24h; tests override to make ticks observable. */
  intervalMs?: number;
  /** Override the prisma client. Defaults to the runner's singleton; tests inject a fake. */
  prisma?: PrismaClient;
  /** AddressBook database paths. Defaults to auto-discovery under $HOME. */
  dbPaths?: string[];
  /** macOS Messages chat.db path. Defaults to the runner's iMessage config. */
  chatDbPath?: string;
}

export interface BirthdaySyncResult {
  /** AddressBook contacts that carry a birthday. */
  scanned: number;
  /** iMessage Person rows resolved to one of those contacts. */
  matched: number;
  /** Person rows whose stored birthday actually changed (a DB write happened). */
  updated: number;
}

interface BirthdayValue {
  monthDay: string;
  year: number | null;
}

export interface BirthdaySync {
  start(): void;
  stop(): void;
  /** Run one tick synchronously; exposed for tests + admin endpoints. */
  tick(): Promise<BirthdaySyncResult>;
}

const DAILY_MS = 24 * 60 * 60 * 1000;

/** Normalized phone (last 10 digits) or email key for a raw handle, or null. */
function handleKey(raw: string): string | null {
  const trimmed = raw.trim();
  // A comma marks a joined multi-handle string - a group-chat displayName,
  // never a single contact. Without this guard normalizePhone would mash the
  // group's numbers together and the trailing 10 digits could collide with a
  // real contact, assigning that birthday to the group thread.
  if (!trimmed || trimmed.includes(",")) return null;
  return trimmed.includes("@") ? normalizeEmail(trimmed) : normalizePhone(trimmed);
}

export function createBirthdaySync(deps: BirthdaySyncDeps = {}): BirthdaySync {
  const intervalMs = deps.intervalMs ?? DAILY_MS;
  const prisma: PrismaClient = deps.prisma ?? defaultPrisma;
  const chatDbPath = deps.chatDbPath ?? runnerConfig.imessage.dbPath;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /**
   * Bridge each iMessage chat guid to a birthday by reading chat.db: a 1:1
   * chat's single participant handle, normalized, is matched against the
   * macOS Contacts lookup. Best-effort - if chat.db cannot be opened (no
   * Full Disk Access, signed out) the sync falls back to displayName-only
   * matching for the unresolved contacts.
   */
  function birthdaysByChatGuid(byHandle: Map<string, BirthdayValue>): Map<string, BirthdayValue> {
    const guidBirthday = new Map<string, BirthdayValue>();
    let db: IMessageDb | null = null;
    try {
      db = new IMessageDb(chatDbPath);
      for (const [guid, handles] of db.listChatHandleMap()) {
        // Only 1:1 chats: a group's birthday assignment would be ambiguous.
        if (handles.length !== 1) continue;
        const key = handleKey(handles[0] ?? "");
        if (!key) continue;
        const birthday = byHandle.get(key);
        if (birthday) guidBirthday.set(guid, birthday);
      }
    } catch {
      // chat.db unreadable (no Full Disk Access, signed out); skip the bridge.
    } finally {
      db?.close();
    }
    return guidBirthday;
  }

  async function tick(): Promise<BirthdaySyncResult> {
    if (running) return { scanned: 0, matched: 0, updated: 0 };
    running = true;
    try {
      const contacts = readAllAddressBookBirthdays(deps.dbPaths);

      // Normalized phone/email -> birthday. Last contact wins on a key
      // collision, matching contact-resolver's resolution semantics.
      const byHandle = new Map<string, BirthdayValue>();
      for (const contact of contacts) {
        const value: BirthdayValue = { monthDay: contact.monthDay, year: contact.year };
        for (const phone of contact.phones) {
          const key = normalizePhone(phone);
          if (key) byHandle.set(key, value);
        }
        for (const email of contact.emails) {
          const key = normalizeEmail(email);
          if (key) byHandle.set(key, value);
        }
      }
      if (byHandle.size === 0) {
        return { scanned: contacts.length, matched: 0, updated: 0 };
      }

      // chat.db bridges a Thread (keyed by an opaque chat guid) back to the
      // contact handle; the Person row itself stores no handle.
      const guidBirthday = birthdaysByChatGuid(byHandle);

      const people = await prisma.person.findMany({
        where: { platform: "IMESSAGE" },
        select: {
          id: true,
          displayName: true,
          birthday: true,
          birthYear: true,
          threads: { select: { platformThreadId: true } }
        }
      });

      let matched = 0;
      let updated = 0;
      for (const person of people) {
        // Route 1: an unresolved contact keeps the raw phone/email as its
        // displayName. Route 2: bridge the person's threads through chat.db.
        const nameKey = handleKey(person.displayName);
        let birthday: BirthdayValue | undefined = nameKey ? byHandle.get(nameKey) : undefined;
        if (!birthday) {
          for (const thread of person.threads) {
            const found = guidBirthday.get(thread.platformThreadId);
            if (found) {
              birthday = found;
              break;
            }
          }
        }
        if (!birthday) continue;
        matched++;
        // Skip no-op writes so the Person.updatedAt stamp is not churned.
        if (person.birthday === birthday.monthDay && person.birthYear === birthday.year) {
          continue;
        }
        await prisma.person.update({
          where: { id: person.id },
          data: { birthday: birthday.monthDay, birthYear: birthday.year }
        });
        updated++;
      }
      return { scanned: contacts.length, matched, updated };
    } finally {
      running = false;
    }
  }

  function logResult(result: BirthdaySyncResult): void {
    // Counts only - never contact names or handles (see contact-resolver).
    console.info(
      `[birthday-sync] ${result.scanned} contacts with birthdays, ` +
        `${result.matched} matched to people, ${result.updated} updated`
    );
  }

  function logError(error: unknown): void {
    console.warn(
      `[birthday-sync] tick failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  function start(): void {
    if (timer) return;
    // Run once immediately so a runner restart re-syncs without waiting a
    // full day, then settle into the interval.
    void tick().then(logResult).catch(logError);
    timer = setInterval(() => {
      void tick().then(logResult).catch(logError);
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
