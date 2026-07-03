import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";
import { runnerConfig } from "../config";
import {
  buildContactResolver,
  loadAddressBookEntries,
  loadVcardEntries
} from "./contact-resolver";
import { planNameBackfill } from "../scripts/backfill-imessage-names-plan";

/**
 * Repairs already-imported iMessage rows whose name is still a raw phone/email
 * handle, rewriting them to the real contact name read from the live macOS
 * Contacts (+ optional vCard). Runs once at boot and then daily, mirroring
 * birthday-sync.
 *
 * Why this exists: chat.db only stores handles, so before a contact source was
 * wired in, every 1:1 thread persisted "+447…" into Person.displayName and
 * group bubbles persisted it into Message.senderName. The adapter now resolves
 * names for *new* reads, but existing rows would stay as numbers without this
 * pass — so a pilot updating the app would still see numbers (issue #676).
 *
 * Safety: reuses the pure, unit-tested planNameBackfill. Only rows whose label
 * still looks like a bare handle AND resolve to a real name are rewritten;
 * real names and operator-set names are never touched. Idempotent — once a row
 * is a real name it is skipped, so steady-state ticks write nothing.
 *
 * Privacy: counts only are logged, never handle→name pairs.
 */

interface ImessageNameSyncDeps {
  /** Polling cadence in ms. Defaults to 24h; tests override to make ticks observable. */
  intervalMs?: number;
  /** Override the prisma client. Defaults to the runner's singleton; tests inject a fake. */
  prisma?: PrismaClient;
  /**
   * vCard path. Defaults to the runner's iMessage config. Pass null to skip
   * the vCard read entirely — tests use this so the machine's real
   * data/contacts.vcf (a live-Contacts export) can never leak into a fixture
   * run.
   */
  vcfPath?: string | null;
  /** AddressBook DB paths. Defaults to auto-discovery under $HOME. */
  addressBookDbPaths?: string[];
  /** Force-enable/disable the live macOS Contacts read. Defaults to macOS-only. */
  useAddressBook?: boolean;
}

export interface ImessageNameSyncResult {
  /** Distinct handle keys loaded across both sources. */
  contactsLoaded: number;
  /** Contacts read from the live macOS Contacts only (0 ⇒ empty Mac address book). */
  addressBookContactCount: number;
  /** Person.displayName rows rewritten this tick. */
  personChanges: number;
  /** Message.senderName rows rewritten this tick. */
  messageChanges: number;
  /** iMessage people still showing a raw handle after the tick (no contact matched). */
  unresolvedHandleCount: number;
}

/**
 * Snapshot the dashboard reads to decide whether to show the "this Mac has no
 * saved contacts" hint. Recomputed every tick.
 */
export interface ImessageContactHealth {
  contactsLoaded: number;
  addressBookContactCount: number;
  unresolvedImessageHandleCount: number;
  /**
   * True when the live macOS Contacts read returned nothing AND there are
   * still iMessage people stuck on a raw handle — i.e. names can't show
   * because the Mac's own address book is empty. Drives the dashboard hint.
   */
  shouldHintEmptyContacts: boolean;
  /** ISO timestamp of the last tick. */
  lastCheckedAt: string;
}

export interface ImessageNameSync {
  start(): void;
  stop(): void;
  /** Run one tick synchronously; exposed for tests + admin endpoints. */
  tick(): Promise<ImessageNameSyncResult>;
  /** Latest health snapshot, or null until the first tick completes. */
  getHealth(): ImessageContactHealth | null;
}

const DAILY_MS = 24 * 60 * 60 * 1000;

export function createImessageNameSync(deps: ImessageNameSyncDeps = {}): ImessageNameSync {
  const intervalMs = deps.intervalMs ?? DAILY_MS;
  const prisma: PrismaClient = deps.prisma ?? defaultPrisma;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let health: ImessageContactHealth | null = null;

  async function tick(): Promise<ImessageNameSyncResult> {
    if (running) {
      return {
        contactsLoaded: 0,
        addressBookContactCount: 0,
        personChanges: 0,
        messageChanges: 0,
        unresolvedHandleCount: 0
      };
    }
    running = true;
    try {
      const addressBookEntries = loadAddressBookEntries({
        dbPaths: deps.addressBookDbPaths,
        enabled: deps.useAddressBook
      });
      const vcardEntries =
        deps.vcfPath === null
          ? []
          : loadVcardEntries(deps.vcfPath ?? runnerConfig.imessage.contactsVcfPath);
      const resolver = buildContactResolver([...addressBookEntries, ...vcardEntries]);
      const addressBookContactCount = addressBookEntries.length;
      const contactsLoaded = resolver.size();

      const persons = await prisma.person.findMany({
        where: { platform: "IMESSAGE" },
        select: { id: true, displayName: true }
      });
      // Planning message rewrites scans every iMessage message with a sender
      // label; skip that read entirely when we have no names to map to.
      const messages =
        contactsLoaded > 0
          ? await prisma.message.findMany({
              where: { thread: { platform: "IMESSAGE" }, senderName: { not: null } },
              select: { id: true, senderName: true }
            })
          : [];

      const plan = planNameBackfill(persons, messages, resolver);

      let personChanges = 0;
      for (const change of plan.personChanges) {
        await prisma.person.update({
          where: { id: change.id },
          data: { displayName: change.to, inferredName: null }
        });
        personChanges += 1;
      }
      let messageChanges = 0;
      for (const change of plan.messageChanges) {
        await prisma.message.update({
          where: { id: change.id },
          data: { senderName: change.to }
        });
        messageChanges += 1;
      }

      const unresolvedHandleCount = plan.unmatchedPersons;
      health = {
        contactsLoaded,
        addressBookContactCount,
        unresolvedImessageHandleCount: unresolvedHandleCount,
        shouldHintEmptyContacts: addressBookContactCount === 0 && unresolvedHandleCount > 0,
        lastCheckedAt: new Date().toISOString()
      };

      return {
        contactsLoaded,
        addressBookContactCount,
        personChanges,
        messageChanges,
        unresolvedHandleCount
      };
    } finally {
      running = false;
    }
  }

  function logResult(result: ImessageNameSyncResult): void {
    // Counts only — never contact names or handles.
    console.info(
      `[imessage-name-sync] ${result.contactsLoaded} contacts loaded ` +
        `(addressBook=${result.addressBookContactCount}); renamed ${result.personChanges} people, ` +
        `${result.messageChanges} message senders; ${result.unresolvedHandleCount} still unresolved`
    );
    if (health?.shouldHintEmptyContacts) {
      console.warn(
        "[imessage-name-sync] this Mac's Contacts is empty. iMessage names cannot resolve. " +
          "See docs/pilot/imessage-contact-names.md (turn on iCloud Contacts on this Mac, then re-scan)."
      );
    }
  }

  function logError(error: unknown): void {
    console.warn(
      `[imessage-name-sync] tick failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  function start(): void {
    if (timer) return;
    // Run once immediately so a runner restart re-syncs without waiting a full
    // day, then settle into the interval.
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

  return { start, stop, tick, getHealth: () => health };
}
