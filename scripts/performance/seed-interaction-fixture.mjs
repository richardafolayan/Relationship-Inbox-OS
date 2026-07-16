import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/(perf|benchmark)/i.test(databaseUrl)) {
  throw new Error("DATABASE_URL must point to an isolated performance or benchmark database.");
}

const totalThreads = Number(process.env.PERF_THREADS ?? 1000);
const messagesPerThread = Number(process.env.PERF_MESSAGES_PER_THREAD ?? 20);
const batchSize = 100;
const prisma = new PrismaClient();
const now = Date.now();

await prisma.message.deleteMany({ where: { id: { startsWith: "perf-message-" } } });
await prisma.thread.deleteMany({ where: { id: { startsWith: "perf-thread-" } } });
await prisma.person.deleteMany({ where: { id: { startsWith: "perf-person-" } } });

for (let offset = 0; offset < totalThreads; offset += batchSize) {
  const count = Math.min(batchSize, totalThreads - offset);
  const people = [];
  const threads = [];
  const messages = [];

  for (let local = 0; local < count; local += 1) {
    const index = offset + local;
    const suffix = String(index).padStart(5, "0");
    const personId = `perf-person-${suffix}`;
    const threadId = `perf-thread-${suffix}`;
    const platform = index % 2 === 0 ? "LINKEDIN" : "IMESSAGE";
    const riskLevel = index % 9 === 0 ? "RED" : index % 4 === 0 ? "AMBER" : "GREEN";
    const lastMessageAt = new Date(now - index * 60_000);

    people.push({
      id: personId,
      displayName: `Performance Contact ${suffix}`,
      handle: `perf-contact-${index}`,
      platform,
      tagsJson: index % 5 === 0 ? JSON.stringify(["Study group"]) : null
    });
    threads.push({
      id: threadId,
      platform,
      platformThreadId: `perf-platform-thread-${index}`,
      personId,
      unreadCount: index % 3,
      needsReply: index % 4 !== 0,
      lastMessagePreview: `Synthetic benchmark message ${index} about project planning and next steps`,
      lastMessageAt,
      lastInboundAt: lastMessageAt,
      lastOutboundAt: new Date(lastMessageAt.getTime() - 3_600_000),
      riskLevel,
      slaDueAt: new Date(lastMessageAt.getTime() + 6 * 3_600_000),
      riskReason: "Synthetic benchmark fixture",
      rollingSummary: `Synthetic conversation ${index} about project planning.`,
      whatTheyWant: "Confirm the next step and timing.",
      openLoopsJson: JSON.stringify(["Confirm the next step"]),
      category: index % 7 === 0 ? "outreach" : "genuine",
      lastMessageDirection: "IN",
      lastMessageText: `Synthetic benchmark message ${index} about project planning and next steps`
    });

    for (let messageIndex = 0; messageIndex < messagesPerThread; messageIndex += 1) {
      const direction = messageIndex % 2 === 0 ? "IN" : "OUT";
      messages.push({
        id: `perf-message-${index}-${messageIndex}`,
        threadId,
        platformMessageKey: `perf-${index}-${messageIndex}`,
        direction,
        timestamp: new Date(lastMessageAt.getTime() - (messagesPerThread - messageIndex) * 300_000),
        text: `Synthetic ${direction === "IN" ? "inbound" : "outbound"} message ${messageIndex} for benchmark thread ${index}.`
      });
    }
  }

  await prisma.person.createMany({ data: people });
  await prisma.thread.createMany({ data: threads });
  await prisma.message.createMany({ data: messages });
}

await prisma.$disconnect();
console.log(JSON.stringify({ databaseUrl, totalThreads, messagesPerThread }));
