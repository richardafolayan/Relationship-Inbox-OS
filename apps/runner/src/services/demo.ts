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

export async function seedDemoData(input: { screenshotDir: string; domDumpDir: string }): Promise<DemoSeedManifest> {
  const now = Date.now();
  const manifest: DemoSeedManifest = {
    seededAt: new Date(now).toISOString(),
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
