#!/usr/bin/env node
/**
 * Seed ONE synthetic iMessage thread for live-testing the #273 private-API
 * native-send layer via the mock helper. DEV/TEST ONLY.
 *
 * Why synthetic (not a real chat.db scan): the contact handle is a reserved
 * fictional number (+1-555-0100), so even the *fallback* paths (mock down /
 * MOCK_FAIL_REPLIES) can never deliver a real iMessage to a real person, and
 * no real private data lands in this throwaway worktree DB.
 *
 * Run: DATABASE_URL=file:<repo>/data/inbox-os.sqlite node tools/seed-imessage-test-thread.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CHAT_GUID = "iMessage;-;+15550100273"; // Thread.platformThreadId -> chatGuid
const HANDLE = "+15550100273"; // fictional 555-0100 range; never reaches anyone
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

async function main() {
  await prisma.platform.upsert({
    where: { name: "IMESSAGE" },
    update: { status: "CONNECTED" },
    create: { name: "IMESSAGE", status: "CONNECTED" }
  });

  const person = await prisma.person.create({
    data: {
      displayName: "Native Send Test",
      handle: HANDLE,
      platform: "IMESSAGE"
    }
  });

  const thread = await prisma.thread.create({
    data: {
      platform: "IMESSAGE",
      platformThreadId: CHAT_GUID,
      personId: person.id,
      needsReply: true,
      unreadCount: 2,
      riskLevel: "GREEN",
      lastMessagePreview: "Let me know what time works for you.",
      lastMessageText: "Let me know what time works for you.",
      lastMessageDirection: "IN",
      lastMessageAt: new Date(now - 60_000),
      lastInboundAt: new Date(now - 60_000)
    }
  });

  // Two inbound messages: react to / reply to either. platformMessageKey is the
  // Apple message GUID the native helper receives as parent/target guid.
  const msg1 = await prisma.message.create({
    data: {
      threadId: thread.id,
      platformMessageKey: "B1A2C3D4-0000-4000-8000-000000000001",
      direction: "IN",
      timestamp: new Date(now - 600_000),
      text: "Hey! Are we still on for coffee Thursday? ☕️",
      senderName: "Native Send Test"
    }
  });

  const msg2 = await prisma.message.create({
    data: {
      threadId: thread.id,
      platformMessageKey: "B1A2C3D4-0000-4000-8000-000000000002",
      direction: "IN",
      timestamp: new Date(now - 60_000),
      text: "Let me know what time works for you.",
      senderName: "Native Send Test"
    }
  });

  console.log("Seeded iMessage test thread:");
  console.log("  threadId :", thread.id);
  console.log("  chatGuid :", CHAT_GUID);
  console.log("  person   :", person.displayName, `(${HANDLE})`);
  console.log("  messages :", msg1.id, "|", msg2.id);
  console.log("  open at  : /thread/" + thread.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("SEED FAILED:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
