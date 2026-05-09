/**
 * Walk every IMESSAGE Person whose displayName looks like a phone or
 * email and rewrite displayName to the matched vcf contact name. Clears
 * inferredName since the operator has authoritative ground truth now.
 *
 * One-shot script — run once after dropping a new contacts.vcf into
 * data/. The iMessage adapter resolves names on every scan going
 * forward, so future personas land with the right name from the start.
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

  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  for (const person of persons) {
    if (!looksLikeUnresolvedHandle(person.displayName)) {
      skipped += 1;
      continue;
    }
    const realName = resolver.resolve(person.displayName);
    if (!realName) {
      unmatched += 1;
      continue;
    }
    await prisma.person.update({
      where: { id: person.id },
      data: { displayName: realName, inferredName: null }
    });
    updated += 1;
    console.log(`[backfill] ${person.displayName}  ->  ${realName}`);
  }

  console.log(`[backfill] done. updated=${updated} skipped=${skipped} unmatched=${unmatched}`);
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error("[backfill] failed", error);
  process.exit(1);
});
