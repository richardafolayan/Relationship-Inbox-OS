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
 *
 * DRY RUN by default: prints every intended displayName/senderName old -> new
 * change and writes NOTHING. Pass `--apply` to perform the overwrite. This
 * mirrors dedupe-imessage-people.ts — the rewrite is irreversible (the stored
 * handle label is discarded), so a wrong/stale contacts.vcf must never silently
 * relabel people or message bubbles without a preview first.
 *
 * The resolve/skip/unmatched decision lives in backfill-imessage-names-plan.ts
 * (pure, unit-tested); this file is the DB-touching executable wrapper.
 *
 * Usage:
 *   tsx src/scripts/backfill-imessage-names.ts            # dry run (default)
 *   tsx src/scripts/backfill-imessage-names.ts --apply    # perform the rewrite
 */
import { prisma } from "../db";
import { runnerConfig } from "../config";
import { loadBestContactResolver } from "../services/contact-resolver";
import { planNameBackfill } from "./backfill-imessage-names-plan";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  // Live macOS Contacts + optional data/contacts.vcf. The runner's
  // imessage-name-sync service does this automatically at boot now; this
  // script stays as a manual, dry-run-by-default escape hatch.
  const resolver = loadBestContactResolver({ vcfPath: runnerConfig.imessage.contactsVcfPath });
  if (resolver.size() === 0) {
    console.error(
      "[backfill] no contacts loaded. This Mac's Contacts is empty and there is no " +
        `data/contacts.vcf (${runnerConfig.imessage.contactsVcfPath ?? "unset"}). ` +
        "See docs/pilot/imessage-contact-names.md to get contacts onto this Mac."
    );
    process.exit(1);
  }
  console.log(`[backfill] loaded ${resolver.size()} contact entries`);

  const persons = await prisma.person.findMany({
    where: { platform: "IMESSAGE" },
    select: { id: true, displayName: true, inferredName: true }
  });

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

  const plan = planNameBackfill(persons, messages, resolver);

  for (const change of plan.personChanges) {
    console.log(`[backfill] ${apply ? "person" : "would rewrite person"} ${change.from}  ->  ${change.to}`);
  }
  for (const change of plan.messageChanges) {
    console.log(`[backfill] ${apply ? "message" : "would rewrite message"} ${change.from}  ->  ${change.to}`);
  }

  if (!apply) {
    console.log(
      `[backfill] DRY RUN — nothing written. persons: ${plan.personChanges.length} to rewrite, ` +
        `${plan.skippedPersons} already named, ${plan.unmatchedPersons} unmatched · ` +
        `messages: ${plan.messageChanges.length} to rewrite, ${plan.skippedMessages} already named, ` +
        `${plan.unmatchedMessages} unmatched. Re-run with --apply to perform the rewrite.`
    );
    await prisma.$disconnect();
    return;
  }

  let updatedPersons = 0;
  for (const change of plan.personChanges) {
    await prisma.person.update({
      where: { id: change.id },
      data: { displayName: change.to, inferredName: null }
    });
    updatedPersons += 1;
  }

  let updatedMessages = 0;
  for (const change of plan.messageChanges) {
    await prisma.message.update({
      where: { id: change.id },
      data: { senderName: change.to }
    });
    updatedMessages += 1;
  }

  console.log(
    `[backfill] persons updated=${updatedPersons} skipped=${plan.skippedPersons} unmatched=${plan.unmatchedPersons}`
  );
  console.log(
    `[backfill] messages updated=${updatedMessages} skipped=${plan.skippedMessages} unmatched=${plan.unmatchedMessages}`
  );
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error("[backfill] failed", error);
  process.exit(1);
});
