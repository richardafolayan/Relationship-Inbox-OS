/**
 * Walk every IMESSAGE Person whose displayName looks like a phone or
 * email and rewrite displayName to the matched vcf contact name. Clears
 * inferredName since the operator has authoritative ground truth now.
 *
 * Also walks IMESSAGE Message rows whose senderName is a raw handle so
 * group-chat bubbles render "Marianne" instead of "+15551234567" (issue
 * #144). The adapter resolves senderName on new messages going forward.
 *
 * One-shot script — run once after dropping a new contacts.vcf into
 * data/.
 */
import { prisma } from "../db";
import { runnerConfig } from "../config";
import { loadContactResolver } from "../services/contact-resolver";
import { looksLikeUnresolvedHandle } from "../services/name-inference";

async function main(): Promise<void> {
  const resolver = loadContactResolver(runnerConfig.imessage.contactsVcfPath);
  if (resolver.size() === 0) {
    console.error(`[backfill] no contacts loaded from ${runnerConfig.imessage.contactsVcfPath ?? "(unset)"}`);
    process.exit(1);
  }
  console.log(`[backfill] loaded ${resolver.size()} contact entries`);

  const persons = await prisma.person.findMany({
    where: { platform: "IMESSAGE" },
    select: { id: true, displayName: true, inferredName: true }
  });

  let updatedPersons = 0;
  let skippedPersons = 0;
  let unmatchedPersons = 0;
  for (const person of persons) {
    if (!looksLikeUnresolvedHandle(person.displayName)) {
      skippedPersons += 1;
      continue;
    }
    const realName = resolver.resolve(person.displayName);
    if (!realName) {
      unmatchedPersons += 1;
      continue;
    }
    await prisma.person.update({
      where: { id: person.id },
      data: { displayName: realName, inferredName: null }
    });
    updatedPersons += 1;
    console.log(`[backfill] person ${person.displayName}  ->  ${realName}`);
  }

  // Pull every message that has a senderName so we can rewrite the
  // unresolved handles. Filtering on platform IMESSAGE via the thread
  // relation keeps the pass scoped — LinkedIn senderName values are
  // already real names from the adapter.
  const messages = await prisma.message.findMany({
    where: {
      thread: { platform: "IMESSAGE" },
      senderName: { not: null }
    },
    select: { id: true, senderName: true }
  });

  let updatedMessages = 0;
  let skippedMessages = 0;
  let unmatchedMessages = 0;
  for (const message of messages) {
    const sender = message.senderName ?? "";
    if (!looksLikeUnresolvedHandle(sender)) {
      skippedMessages += 1;
      continue;
    }
    const realName = resolver.resolve(sender);
    if (!realName) {
      unmatchedMessages += 1;
      continue;
    }
    await prisma.message.update({
      where: { id: message.id },
      data: { senderName: realName }
    });
    updatedMessages += 1;
  }

  console.log(
    `[backfill] persons updated=${updatedPersons} skipped=${skippedPersons} unmatched=${unmatchedPersons}`
  );
  console.log(
    `[backfill] messages updated=${updatedMessages} skipped=${skippedMessages} unmatched=${unmatchedMessages}`
  );
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error("[backfill] failed", error);
  process.exit(1);
});
