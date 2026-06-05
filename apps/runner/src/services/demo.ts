import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../db";
import type { PlatformName } from "@inbox-os/core";
import type { DemoSeedManifest } from "../types/runtime";

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

/**
 * Mode controls which deterministic showcase records are seeded.
 *  - "generic"             — the legacy 15-contact placeholder seed plus a
 *                            fake SELECTOR_FAIL audit log. Used by the
 *                            existing demoMode toggle.
 *  - "full-presenter-demo" — the curated showcase used by the presenter
 *                            demo: Serena (IMESSAGE), Timi (LINKEDIN),
 *                            Brandon (LINKEDIN), a multi-open-loop thread,
 *                            a reconnect candidate, a snoozed thread, and
 *                            an archived thread, with deterministic
 *                            platformThreadIds. No fake degraded banner.
 */
export type DemoSeedMode = "generic" | "full-presenter-demo";

export interface SeedDemoInput {
  screenshotDir: string;
  domDumpDir: string;
  mode?: DemoSeedMode;
}

interface ShowcaseMessage {
  direction: "IN" | "OUT";
  text: string;
  /** Minutes before lastInboundAt. Negative means after (newer). */
  offsetMinutes: number;
}

interface ShowcaseThread {
  platformThreadId: string;
  displayName: string;
  platform: PlatformName;
  tags: string[];
  /** Hours ago for the latest inbound. */
  lastInboundAgoHours: number;
  /** When set, marks the thread as snoozed until N hours in the future. */
  snoozedInHours?: number;
  /** When true, archivedAt is set to now-1d. */
  archived?: boolean;
  /** When true, marks the thread as needing a reply. */
  needsReply: boolean;
  rollingSummary: string;
  whatTheyWant: string;
  openLoops: string[];
  toneNotes: string[];
  remember: Array<{ note: string; date: string | null }>;
  messages: ShowcaseMessage[];
  riskLevel: "RED" | "AMBER" | "GREEN";
  riskReason: string;
  category?: "outreach" | "genuine";
  reconnectScore?: number;
  reconnectScoreReason?: string;
  /** Optional override; defaults to now - lastInboundAgoHours. */
  lastOutboundAgoHours?: number;
}

export function buildShowcaseThreads(now: number): ShowcaseThread[] {
  return [
    {
      platformThreadId: "demo-full-serena-imessage",
      displayName: "Serena",
      platform: "IMESSAGE",
      tags: ["Close friend"],
      lastInboundAgoHours: 3,
      lastOutboundAgoHours: 5,
      needsReply: true,
      riskLevel: "AMBER",
      riskReason: "Unread inbound waiting > 3h",
      category: "genuine",
      rollingSummary:
        "You and Serena have been planning a catch-up. She has just confirmed she is free on Saturday and is asking where to meet.",
      whatTheyWant: "Pick a spot for Saturday and lock in a time.",
      openLoops: [
        "Suggest a venue for Saturday",
        "Confirm a time that works for both of you"
      ],
      toneNotes: ["Warm", "Casual"],
      remember: [
        { note: "Just started a new role at the gallery", date: null },
        {
          note: "Trip to Lisbon next month",
          date: new Date(now + 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        }
      ],
      messages: [
        {
          direction: "IN",
          text: "Heyyy, are you around this weekend? Been ages",
          offsetMinutes: 60 * 24
        },
        {
          direction: "OUT",
          text: "Yes! Saturday afternoon works for me — fancy a coffee?",
          offsetMinutes: 60 * 6
        },
        {
          direction: "IN",
          text: "Perfect, Saturday works. Where are you thinking? I can come your way.",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-timi-linkedin",
      displayName: "Timi",
      platform: "LINKEDIN",
      tags: ["Old colleague"],
      lastInboundAgoHours: 12,
      needsReply: true,
      riskLevel: "GREEN",
      riskReason: "Friendly update — no direct ask",
      category: "genuine",
      rollingSummary:
        "Timi has shared an update on his new role and mentioned he is enjoying the team. Not asking for anything specific — checking in on you in passing.",
      whatTheyWant: "Just sharing an update. A short, warm reply is enough.",
      openLoops: [
        "Acknowledge his news and respond lightly"
      ],
      toneNotes: ["Friendly", "Light"],
      remember: [
        { note: "Moved to a product role at Monzo", date: null },
        { note: "Used to work together at the old startup", date: null }
      ],
      messages: [
        {
          direction: "OUT",
          text: "Congrats on the move! How is it going so far?",
          offsetMinutes: 60 * 24 * 5
        },
        {
          direction: "IN",
          text: "Honestly settling in nicely. The team is lovely and the work is interesting. How is everything your side?",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-brandon-linkedin",
      displayName: "Brandon",
      platform: "LINKEDIN",
      tags: ["Recruiter"],
      lastInboundAgoHours: 26,
      needsReply: true,
      riskLevel: "RED",
      riskReason: "Inbound waiting > 18h",
      category: "outreach",
      rollingSummary:
        "Brandon reached out about a senior product role at a fintech. He has shared a short brief and asked whether you would like to chat.",
      whatTheyWant: "A yes / no on whether you want a 20-minute call.",
      openLoops: [
        "Decide if the role is a fit",
        "Reply with a yes or a polite pass"
      ],
      toneNotes: ["Polite", "Direct"],
      remember: [
        { note: "Recruiter at Talenthouse", date: null }
      ],
      messages: [
        {
          direction: "IN",
          text: "Hi — I wanted to flag a senior product role at a Series B fintech that looks aligned with your background. Quick 20-min chat this week?",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-multi-open-loop",
      displayName: "Priya Shah",
      platform: "IMESSAGE",
      tags: ["Project partner"],
      lastInboundAgoHours: 8,
      needsReply: true,
      riskLevel: "AMBER",
      riskReason: "Multiple open items waiting",
      category: "genuine",
      rollingSummary:
        "Priya has sent through several points on the joint workshop: a venue option, a date, a draft agenda, and a question about budget.",
      whatTheyWant: "Work through her four items so the workshop can be locked.",
      openLoops: [
        "Confirm the venue option",
        "Agree a date",
        "Sign off on the draft agenda",
        "Share the budget you have to work with"
      ],
      toneNotes: ["Direct", "Collaborative"],
      remember: [
        { note: "Co-organising the autumn workshop", date: null }
      ],
      messages: [
        {
          direction: "OUT",
          text: "Quick one — how is the workshop planning coming along?",
          offsetMinutes: 60 * 24
        },
        {
          direction: "IN",
          text: "Few things to land. I found a space in Shoreditch — pretty good light, holds about 30. Thinking the Saturday after next?",
          offsetMinutes: 60 * 2
        },
        {
          direction: "IN",
          text: "Also drafted the agenda — short intro, two workshops, a long lunch, then open studio. Will share the doc.",
          offsetMinutes: 60
        },
        {
          direction: "IN",
          text: "Last thing — what is the budget? Want to make sure the catering does not blow it.",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-reconnect",
      displayName: "Marcus Reid",
      platform: "LINKEDIN",
      tags: ["Old contact"],
      lastInboundAgoHours: 24 * 45,
      needsReply: false,
      riskLevel: "GREEN",
      riskReason: "Dormant — worth a light hello",
      category: "genuine",
      reconnectScore: 78,
      reconnectScoreReason:
        "Strong prior rapport and Marcus recently changed roles — natural moment for a warm hello.",
      rollingSummary:
        "You have not spoken with Marcus in over a month. The last exchange was a friendly thread about his job hunt. He has since started somewhere new.",
      whatTheyWant: "Nothing pending — this is a reconnect prompt.",
      openLoops: [
        "Send a warm hello and ask how the new role is",
        "Mention something specific from your last conversation"
      ],
      toneNotes: ["Warm", "Unhurried"],
      remember: [
        { note: "Was interviewing in March", date: null }
      ],
      messages: [
        {
          direction: "OUT",
          text: "Fingers crossed for the final round — let me know how it goes.",
          offsetMinutes: 60 * 24 * 50
        },
        {
          direction: "IN",
          text: "Thanks! It went well — accepted the offer in the end. Will share more soon.",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-snoozed",
      displayName: "Jade Okafor",
      platform: "IMESSAGE",
      tags: ["Friend"],
      lastInboundAgoHours: 24,
      snoozedInHours: 2,
      needsReply: false,
      riskLevel: "GREEN",
      riskReason: "Snoozed until later today",
      category: "genuine",
      rollingSummary:
        "Jade is sorting dinner plans for Friday — she asked you to suggest a restaurant. You snoozed the thread so it would resurface this afternoon.",
      whatTheyWant: "Pick somewhere for Friday dinner.",
      openLoops: [
        "Suggest a restaurant"
      ],
      toneNotes: ["Casual"],
      remember: [],
      messages: [
        {
          direction: "IN",
          text: "Friday dinner — your pick. Somewhere not too far from mine ideally.",
          offsetMinutes: 0
        }
      ]
    },
    {
      platformThreadId: "demo-full-archived",
      displayName: "Owen Lin",
      platform: "LINKEDIN",
      tags: ["Resolved"],
      lastInboundAgoHours: 24 * 5,
      archived: true,
      needsReply: false,
      riskLevel: "GREEN",
      riskReason: "Archived — kept for reference",
      category: "genuine",
      rollingSummary:
        "Owen confirmed the intro and thanked you for the connection. Nothing else to do here — the thread sits in the archive.",
      whatTheyWant: "Nothing — already wrapped up.",
      openLoops: [],
      toneNotes: ["Polite"],
      remember: [],
      messages: [
        {
          direction: "OUT",
          text: "Glad it worked out — let me know how the chat goes.",
          offsetMinutes: 60 * 24 * 6
        },
        {
          direction: "IN",
          text: "Will do, thanks so much for the intro — really appreciated.",
          offsetMinutes: 0
        }
      ]
    }
  ];
}

async function seedShowcaseThread(thread: ShowcaseThread, now: number, manifest: DemoSeedManifest): Promise<void> {
  const lastInboundAt = new Date(now - thread.lastInboundAgoHours * 60 * 60 * 1000);
  const lastOutboundAt = thread.lastOutboundAgoHours !== undefined
    ? new Date(now - thread.lastOutboundAgoHours * 60 * 60 * 1000)
    : undefined;
  const snoozedUntil = thread.snoozedInHours !== undefined
    ? new Date(now + thread.snoozedInHours * 60 * 60 * 1000)
    : null;
  const archivedAt = thread.archived ? new Date(now - 24 * 60 * 60 * 1000) : null;

  const person = await prisma.person.create({
    data: {
      displayName: thread.displayName,
      platform: thread.platform,
      tagsJson: JSON.stringify(thread.tags)
    }
  });
  manifest.personIds.push(person.id);

  const sortedMessages = [...thread.messages].sort((a, b) => b.offsetMinutes - a.offsetMinutes);
  const lastMessage = sortedMessages[sortedMessages.length - 1];
  const lastMessageDirection = lastMessage?.direction;
  const lastMessageText = lastMessage?.text;

  const created = await prisma.thread.create({
    data: {
      platform: thread.platform,
      platformThreadId: thread.platformThreadId,
      personId: person.id,
      unreadCount: thread.needsReply ? 1 : 0,
      needsReply: thread.needsReply,
      lastMessagePreview: lastMessageText ?? undefined,
      lastMessageAt: lastInboundAt,
      lastInboundAt,
      lastOutboundAt: lastOutboundAt ?? undefined,
      lastMessageDirection: lastMessageDirection ?? undefined,
      lastMessageText: lastMessageText ?? undefined,
      riskLevel: thread.riskLevel,
      riskReason: thread.riskReason,
      rollingSummary: thread.rollingSummary,
      whatTheyWant: thread.whatTheyWant,
      openLoopsJson: JSON.stringify(thread.openLoops),
      toneNotesJson: JSON.stringify(thread.toneNotes),
      rememberJson: JSON.stringify(thread.remember),
      snoozedUntil,
      archivedAt,
      category: thread.category,
      reconnectScore: thread.reconnectScore,
      reconnectScoreReason: thread.reconnectScoreReason
    }
  });
  manifest.threadIds.push(created.id);

  let messageIndex = 0;
  for (const msg of sortedMessages) {
    messageIndex += 1;
    await prisma.message.create({
      data: {
        threadId: created.id,
        platformMessageKey: `${thread.platformThreadId}-msg-${messageIndex}`,
        direction: msg.direction,
        timestamp: new Date(lastInboundAt.getTime() - msg.offsetMinutes * 60 * 1000),
        text: msg.text
      }
    });
  }
}

async function seedGenericPlaceholders(input: { screenshotDir: string; domDumpDir: string; count: number }, manifest: DemoSeedManifest, now: number): Promise<void> {
  for (let i = 0; i < input.count; i += 1) {
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
}

async function writeSelectorFailAuditLog(input: { screenshotDir: string; domDumpDir: string }, manifest: DemoSeedManifest): Promise<void> {
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
}

export async function seedDemoData(input: SeedDemoInput): Promise<DemoSeedManifest> {
  const mode: DemoSeedMode = input.mode ?? "generic";
  const now = Date.now();
  const manifest: DemoSeedManifest = {
    seededAt: new Date(now).toISOString(),
    personIds: [],
    threadIds: [],
    logIds: [],
    screenshotFiles: [],
    domDumpFiles: []
  };

  if (mode === "full-presenter-demo") {
    const showcase = buildShowcaseThreads(now);
    for (const thread of showcase) {
      await seedShowcaseThread(thread, now, manifest);
    }
    // Top up with a small generic batch so the inbox has page density
    // beyond the targeted showcase threads, but skip the SELECTOR_FAIL
    // audit log + screenshot/DOM dump so the presenter demo never shows
    // a fake degraded banner.
    await seedGenericPlaceholders({ ...input, count: 5 }, manifest, now);
    return manifest;
  }

  await seedGenericPlaceholders({ ...input, count: 15 }, manifest, now);
  await writeSelectorFailAuditLog(input, manifest);

  return manifest;
}

async function removeFileIfPresent(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

export async function cleanupDemoData(
  manifest: DemoSeedManifest,
  input: { screenshotDir: string; domDumpDir: string }
): Promise<void> {
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
