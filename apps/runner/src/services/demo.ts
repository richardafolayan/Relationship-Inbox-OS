import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma as defaultPrisma } from "../db";
import type { PlatformName } from "@inbox-os/core";
import type { DemoSeedManifest, DemoSeedMode } from "../types/runtime";

const demoPeople = [
  "Alex Bennett",
  "Sophie Clarke",
  "Nina Patel",
  "Tom Hughes",
  "Imran Malik",
  "Sarah Dalton",
  "Ben Morgan",
  "Olivia Hayes",
  "Jay Carter",
  "Lena Brooks"
];

const platforms: PlatformName[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"];

/** Stable platformThreadIds for the pilot guided tour. The dashboard tour
 *  steps target these ids, so renaming them is a breaking change. */
export const PILOT_TOUR_SERENA_THREAD_ID = "demo-pilot-serena-imessage";
export const PILOT_TOUR_TIMI_THREAD_ID = "demo-pilot-timi-linkedin";

// Subset of the Prisma client the seeder/cleanup actually touch. Tests
// pass a fake matching this shape so they don't need a real DB.
type DemoPrisma = {
  person: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
  thread: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
  message: {
    createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown>;
  };
};

export interface SeedDemoInput {
  screenshotDir: string;
  domDumpDir: string;
  /** Defaults to "generic" — the long-standing 15-row sandbox. "pilot-guided-tour"
   *  seeds the deterministic two-thread set the dashboard tour walks through. */
  mode?: DemoSeedMode;
  /** Optional DI for tests; falls back to the runner's shared prisma client. */
  prisma?: DemoPrisma;
}

export async function seedDemoData(input: SeedDemoInput): Promise<DemoSeedManifest> {
  const mode: DemoSeedMode = input.mode ?? "generic";
  const prisma = input.prisma ?? (defaultPrisma as unknown as DemoPrisma);
  if (mode === "pilot-guided-tour") {
    return seedPilotTour(prisma);
  }
  return seedGeneric(input, prisma);
}

async function seedGeneric(input: SeedDemoInput, prisma: DemoPrisma): Promise<DemoSeedManifest> {
  const now = Date.now();
  const manifest: DemoSeedManifest = {
    seededAt: new Date(now).toISOString(),
    mode: "generic",
    personIds: [],
    threadIds: [],
    logIds: [],
    screenshotFiles: [],
    domDumpFiles: []
  };

  for (let i = 0; i < 15; i += 1) {
    const name = demoPeople[i % demoPeople.length] ?? `Demo Contact ${i + 1}`;
    const platform = platforms[i % platforms.length] ?? "LINKEDIN";

    const person = await prisma.person.create({
      data: {
        displayName: name,
        platform,
        tagsJson: JSON.stringify(i % 2 === 0 ? ["Warm lead"] : ["Partner"])
      }
    });
    manifest.personIds.push(person.id);

    const lastInboundAt = new Date(now - (i + 2) * 60 * 60 * 1000);

    const thread = await prisma.thread.create({
      data: {
        platform,
        platformThreadId: `demo-${platform}-${i}`,
        personId: person.id,
        unreadCount: i % 4,
        needsReply: true,
        lastMessageAt: lastInboundAt,
        lastInboundAt,
        riskLevel: i % 3 === 0 ? "RED" : i % 2 === 0 ? "AMBER" : "GREEN",
        riskReason: i % 3 === 0 ? "Unread inbound waiting > 18h" : "Unread inbound waiting > 6h",
        rollingSummary: `Ongoing conversation with ${name} about partnership timings and next steps.`,
        whatTheyWant: "They want a confirmed timeline this week.",
        openLoopsJson: JSON.stringify(["Confirm timeline", "Share next milestone"]),
        toneNotesJson: JSON.stringify(["Friendly", "Direct"]),
        rememberJson: JSON.stringify([
          {
            note: i % 2 === 0 ? "Final exams" : "Trip to Lisbon",
            date: new Date(now + (i + 4) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          },
          { note: "Just started a new role", date: null }
        ])
      }
    });
    manifest.threadIds.push(thread.id);

    await prisma.message.createMany({
      data: [
        {
          threadId: thread.id,
          platformMessageKey: `demo-${i}-1`,
          direction: "IN",
          timestamp: new Date(lastInboundAt.getTime() - 20 * 60 * 1000),
          text: "Quick one: can we lock a time to review this?"
        },
        {
          threadId: thread.id,
          platformMessageKey: `demo-${i}-2`,
          direction: "OUT",
          timestamp: new Date(lastInboundAt.getTime() - 10 * 60 * 1000),
          text: "Yes, let us line that up tomorrow morning."
        },
        {
          threadId: thread.id,
          platformMessageKey: `demo-${i}-3`,
          direction: "IN",
          timestamp: lastInboundAt,
          text: "Perfect. Could you share availability?"
        }
      ]
    });
  }

  const fileSuffix = Date.now();
  const screenshotFile = `demo-selector-fail-${fileSuffix}.png`;
  const domDumpFile = `demo-selector-fail-${fileSuffix}.html`;
  manifest.screenshotFiles.push(screenshotFile);
  manifest.domDumpFiles.push(domDumpFile);

  await writeFile(join(input.screenshotDir, screenshotFile), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZwN0AAAAASUVORK5CYII=", "base64"));
  await writeFile(join(input.domDumpDir, domDumpFile), "<html><body><h1>Demo DOM dump placeholder</h1></body></html>", "utf-8");

  const log = await prisma.auditLog.create({
    data: {
      platform: "LINKEDIN",
      stage: "Scan",
      action: "SELECTOR_FAIL",
      status: "FAIL",
      detailsJson: JSON.stringify({ reason: "Demo selector mismatch" }),
      screenshotFile,
      domDumpFile
    }
  });
  manifest.logIds.push(log.id);

  return manifest;
}

/**
 * Pilot-tour seed. Two deterministic threads — Serena (IMESSAGE) and Timi
 * (LINKEDIN) — chosen so the tour can walk a pilot tester through a calm
 * iMessage exchange and a longer LinkedIn "catch me up" conversation. No
 * fake selector-fail audit log is created here: a degraded banner mid-tour
 * would contradict the "calm walkthrough" feel.
 *
 * Threads carry stable platformThreadIds (`demo-pilot-serena-imessage` /
 * `demo-pilot-timi-linkedin`) so the dashboard tour can target them with
 * `data-tour` attributes without depending on the runtime-generated row ids.
 */
async function seedPilotTour(prisma: DemoPrisma): Promise<DemoSeedManifest> {
  const now = Date.now();
  const manifest: DemoSeedManifest = {
    seededAt: new Date(now).toISOString(),
    mode: "pilot-guided-tour",
    personIds: [],
    threadIds: [],
    logIds: [],
    screenshotFiles: [],
    domDumpFiles: []
  };

  // ── Serena · iMessage ──────────────────────────────────────────────
  // Synthetic content only. Mirrors the shape of a real "old unanswered
  // message, you previously said something relevant, they replied with a
  // direct human ask" — enough to make the Reply Brief / action items
  // story land without needing real Serena history.
  const serenaPerson = await prisma.person.create({
    data: {
      displayName: "Serena",
      platform: "IMESSAGE",
      tagsJson: JSON.stringify(["demo"])
    }
  });
  manifest.personIds.push(serenaPerson.id);

  const serenaLastInbound = new Date(now - 26 * 60 * 60 * 1000); // ~yesterday
  const serenaPriorOut = new Date(now - 4 * 24 * 60 * 60 * 1000);
  const serenaOlderInbound = new Date(now - 6 * 24 * 60 * 60 * 1000);

  const serenaThread = await prisma.thread.create({
    data: {
      platform: "IMESSAGE",
      platformThreadId: PILOT_TOUR_SERENA_THREAD_ID,
      personId: serenaPerson.id,
      unreadCount: 1,
      needsReply: true,
      lastMessageAt: serenaLastInbound,
      lastInboundAt: serenaLastInbound,
      riskLevel: "RED",
      riskReason: "Unread inbound waiting > 18h",
      rollingSummary:
        "Serena is checking in after the coffee you mentioned last week. She's free Thursday evening and is asking which café works for you.",
      whatTheyWant: "A concrete time and place for Thursday's catch-up.",
      openLoopsJson: JSON.stringify([
        "Pick a café or suggest somewhere quieter",
        "Confirm Thursday 7pm works for you"
      ]),
      toneNotesJson: JSON.stringify(["Warm", "Direct"]),
      rememberJson: JSON.stringify([
        { note: "Just moved flats — still unpacking", date: null },
        { note: "Prefers somewhere quiet, not a loud bar", date: null }
      ])
    }
  });
  manifest.threadIds.push(serenaThread.id);

  await prisma.message.createMany({
    data: [
      {
        threadId: serenaThread.id,
        platformMessageKey: "demo-pilot-serena-1",
        direction: "IN",
        timestamp: serenaOlderInbound,
        text: "Hey! Ages since we caught up properly. Free for a coffee sometime this week?"
      },
      {
        threadId: serenaThread.id,
        platformMessageKey: "demo-pilot-serena-2",
        direction: "OUT",
        timestamp: serenaPriorOut,
        text: "Yes please, would love that. Thursday eve could work — I'll pick somewhere good and let you know."
      },
      {
        threadId: serenaThread.id,
        platformMessageKey: "demo-pilot-serena-3",
        direction: "IN",
        timestamp: serenaLastInbound,
        text: "Thursday 7pm still good? Where are we thinking? I'm easy as long as it's not too loud — moved flat last weekend and still a bit fried."
      }
    ]
  });

  // ── Timi · LinkedIn ────────────────────────────────────────────────
  // Generic LinkedIn content. Slightly longer history so the "catch me up
  // quickly" beat in the tour has something to ground in.
  const timiPerson = await prisma.person.create({
    data: {
      displayName: "Timi",
      platform: "LINKEDIN",
      tagsJson: JSON.stringify(["demo"])
    }
  });
  manifest.personIds.push(timiPerson.id);

  const timiLastInbound = new Date(now - 9 * 24 * 60 * 60 * 1000);
  const timiPriorOut = new Date(now - 12 * 24 * 60 * 60 * 1000);
  const timiOlderInbound = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const timiFirstTouch = new Date(now - 28 * 24 * 60 * 60 * 1000);

  const timiThread = await prisma.thread.create({
    data: {
      platform: "LINKEDIN",
      platformThreadId: PILOT_TOUR_TIMI_THREAD_ID,
      personId: timiPerson.id,
      unreadCount: 1,
      needsReply: true,
      lastMessageAt: timiLastInbound,
      lastInboundAt: timiLastInbound,
      riskLevel: "AMBER",
      riskReason: "Unread inbound waiting > 6h",
      rollingSummary:
        "Timi reached out a month ago about a collaboration on a student-facing project. You traded a few notes, then it went quiet. Her last message asks whether you still have capacity this term and shares a short outline.",
      whatTheyWant: "An answer on whether you still want to collaborate this term.",
      openLoopsJson: JSON.stringify([
        "Say yes or no to the collaboration",
        "Share when you could realistically start"
      ]),
      toneNotesJson: JSON.stringify(["Professional", "Friendly"]),
      rememberJson: JSON.stringify([
        { note: "Final-year student, leading a society project", date: null }
      ])
    }
  });
  manifest.threadIds.push(timiThread.id);

  await prisma.message.createMany({
    data: [
      {
        threadId: timiThread.id,
        platformMessageKey: "demo-pilot-timi-1",
        direction: "IN",
        timestamp: timiFirstTouch,
        text: "Hi — really enjoyed your talk last term. I'm running a small project at uni and wondered if you'd be open to a quick chat about helping out?"
      },
      {
        threadId: timiThread.id,
        platformMessageKey: "demo-pilot-timi-2",
        direction: "OUT",
        timestamp: new Date(timiFirstTouch.getTime() + 2 * 24 * 60 * 60 * 1000),
        text: "Thanks Timi, glad it was useful. Happy to hear more — send over a short outline and I'll have a think."
      },
      {
        threadId: timiThread.id,
        platformMessageKey: "demo-pilot-timi-3",
        direction: "IN",
        timestamp: timiOlderInbound,
        text: "Brilliant — outline attached. Two pages. Main asks are an hour a fortnight for mentoring and a one-off intro to someone in industry."
      },
      {
        threadId: timiThread.id,
        platformMessageKey: "demo-pilot-timi-4",
        direction: "OUT",
        timestamp: timiPriorOut,
        text: "Read it — good shape. Let me check what I've got on this term and come back to you."
      },
      {
        threadId: timiThread.id,
        platformMessageKey: "demo-pilot-timi-5",
        direction: "IN",
        timestamp: timiLastInbound,
        text: "Hey, no rush at all — just nudging in case it slipped. Still keen if you have capacity; happy to scale the ask if not."
      }
    ]
  });

  return manifest;
}

async function removeFileIfPresent(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

export interface CleanupDemoInput {
  screenshotDir: string;
  domDumpDir: string;
  /** Optional DI for tests. */
  prisma?: DemoPrisma;
}

export async function cleanupDemoData(
  manifest: DemoSeedManifest,
  input: CleanupDemoInput
): Promise<void> {
  const prisma = input.prisma ?? (defaultPrisma as unknown as DemoPrisma);

  if (manifest.threadIds.length) {
    await prisma.thread.deleteMany({
      where: {
        id: {
          in: manifest.threadIds
        }
      }
    });
  }

  if (manifest.personIds.length) {
    await prisma.person.deleteMany({
      where: {
        id: {
          in: manifest.personIds
        }
      }
    });
  }

  if (manifest.logIds.length) {
    await prisma.auditLog.deleteMany({
      where: {
        id: {
          in: manifest.logIds
        }
      }
    });
  }

  for (const file of manifest.screenshotFiles) {
    await removeFileIfPresent(join(input.screenshotDir, file));
  }

  for (const file of manifest.domDumpFiles) {
    await removeFileIfPresent(join(input.domDumpDir, file));
  }
}
