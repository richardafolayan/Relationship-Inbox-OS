/**
 * Find Person rows on the IMESSAGE platform that resolve to the same name
 * (after vcf rename / inferredName confirm) and merge them.
 *
 * The same human can land as multiple Person rows because:
 *   - chat.db has 1:1 + group chats with the same handle
 *   - the same person has multiple phones in the vcf
 *   - the displayName drifted between scans before the operator confirmed
 *
 * Canonical rule: keep the Person with the earliest createdAt (it has the
 * most thread history attached). Move every duplicate's threads to the
 * canonical row, copy notes if the canonical's are blank, then delete the
 * duplicate. Cascades take care of EnrichmentJob / PersonEnrichment.
 */
import { prisma } from "../db";

async function main(): Promise<void> {
  const persons = await prisma.person.findMany({
    where: { platform: "IMESSAGE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, displayName: true, createdAt: true, notes: true }
  });

  const groups = new Map<string, typeof persons>();
  for (const p of persons) {
    const key = p.displayName.trim().toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  let merged = 0;
  let touched = 0;
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const [canonical, ...duplicates] = members;
    if (!canonical) continue;
    touched += members.length;
    for (const dup of duplicates) {
      // Move threads + drafts onto the canonical Person.
      await prisma.thread.updateMany({
        where: { personId: dup.id },
        data: { personId: canonical.id }
      });
      // Copy notes only if the canonical doesn't have any (avoid clobbering).
      if (!canonical.notes && dup.notes) {
        await prisma.person.update({
          where: { id: canonical.id },
          data: { notes: dup.notes }
        });
      }
      // Delete the duplicate Person row. PersonEnrichment + EnrichmentJob
      // cascade via Prisma's onDelete: Cascade.
      await prisma.person.delete({ where: { id: dup.id } });
      console.log(`[dedupe] merged ${dup.id}  ->  ${canonical.id} (${canonical.displayName})`);
      merged += 1;
    }
  }

  console.log(`[dedupe] done. merged=${merged} touched_groups=${touched}`);
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error("[dedupe] failed", error);
  process.exit(1);
});
