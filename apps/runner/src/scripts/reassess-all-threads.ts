/**
 * One-shot backfill: re-summarise EVERY thread through the live AI path so
 * persisted summaries / whatTheyWant / open_loops / reply_brief pick up the
 * current prompt. Written for the "Seyi" contact-name fix (PR #473): the old
 * prompt omitted the `Recipient: <name>` line, so the model mislabelled
 * low-signal contacts with the discipline block's example name ("Seyi").
 * New summaries are correct automatically; existing rows only refresh on a
 * scan or operator Reassess — this script forces the refresh for all of them.
 *
 * Uses the SAME pipeline the runner's Reassess endpoint uses
 * (resummarizeThread → aiService.updateThreadSummary), so output matches
 * what the app would produce. Idempotent: safe to re-run.
 *
 * Run it pointed at the live DB, from a worktree that has the fix built in
 * source (tsx runs source, so the fixed prompt is used):
 *
 *   DATABASE_URL=file:/abs/path/to/data/inbox-os.sqlite \
 *     npx tsx apps/runner/src/scripts/reassess-all-threads.ts --apply [--limit N] [--concurrency N] [--ids id1,id2] [--from-scratch]
 *
 * FAIL-CLOSED. Without `--apply` this is a DRY RUN: it counts the threads it
 * WOULD rewrite and writes nothing. `--apply` performs the (destructive)
 * overwrite. An `--ids`-scoped verification run is exempt from the gate. The
 * script also runs a live AI probe up front and aborts (exit 1) if the provider
 * returns a fallback — a present-but-expired/rate-limited key no longer flattens
 * summaries (each thread's write is also skipped individually on a fallback).
 *
 * --from-scratch drops each thread's prior summary/loops/remember from the
 * prompt so the model regenerates purely from the transcript. Use it to
 * de-poison summaries that already carry a bad value (the normal path feeds
 * the prior summary back and preserves it). Costs more model work; for a
 * routine refresh, omit it.
 *
 * Requires OPENAI_API_KEY (or another configured provider) in the .env that
 * dotenv loads from process.cwd().
 */
import { prisma } from "../db";
import { runnerConfig } from "../config";
import { createSettingsStore } from "../services/settings";
import { createAiService } from "../services/ai";
import { resummarizeThread } from "../services/resummarize-thread";
import type { PlatformName } from "@inbox-os/core";

function parseFlag(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return next;
    return "true";
  }
  return undefined;
}

// Mirror the runner's siblingThreadIds (index.ts): iMessage merges messages
// across a person's handle-specific chats; LinkedIn stays thread-scoped.
async function siblingThreadIds(platform: PlatformName, personId: string): Promise<string[]> {
  const rows = await prisma.thread.findMany({
    where: { platform, personId },
    select: { id: true }
  });
  return rows.map((r) => r.id);
}

const isLockError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(msg);
};

async function resummarizeWithRetry(
  deps: Parameters<typeof resummarizeThread>[0],
  threadId: string,
  options: { fromScratch?: boolean } = {},
  attempts = 4
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await resummarizeThread(deps, threadId, options);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true };
    } catch (err) {
      // A live sibling runner may briefly hold the SQLite write lock — back
      // off and retry rather than fail the thread. Other errors fail fast.
      if (isLockError(err) && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, reason: "exhausted lock retries" };
}

async function main(): Promise<void> {
  const limit = parseFlag("limit") ? Number(parseFlag("limit")) : undefined;
  const concurrency = Math.max(1, parseFlag("concurrency") ? Number(parseFlag("concurrency")) : 4);
  // Optional: target specific thread ids (comma-separated) for a verification
  // run. Default targets EVERY thread (archived included), per the ask.
  const idsFlag = parseFlag("ids");
  const targetIds = idsFlag ? idsFlag.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  // De-poison mode: regenerate purely from the transcript, dropping the
  // (possibly poisoned) prior summary so a bad name can't perpetuate itself.
  const fromScratch = parseFlag("from-scratch") !== undefined;
  // FAIL-CLOSED. This rewrites the persisted summary on EVERY targeted thread,
  // so default to a dry run and require an explicit --apply to write. A
  // verification run scoped with `--ids` is exempt — it targets a handful of
  // threads the operator named, not the whole inbox. Mirrors the --apply gate
  // on the other destructive scripts (purge-automated-imessage.ts etc.).
  const apply = process.argv.includes("--apply");

  const settingsStore = createSettingsStore();
  const aiService = createAiService(settingsStore);
  const deps = { prisma, aiService, siblingThreadIds };

  if (!runnerConfig.openAiApiKey && !runnerConfig.zAiApiKey && !runnerConfig.geminiApiKey) {
    console.error("[reassess-all] No AI provider key configured (OPENAI_API_KEY / Z_AI_API_KEY / GEMINI_API_KEY). Aborting — a backfill with no provider would overwrite summaries with fallbacks.");
    process.exit(1);
  }

  // A key being PRESENT does not mean the provider WORKS — it can be expired,
  // rate-limited, out of balance, or the provider can be down. The old guard
  // only checked presence, so a present-but-dead key sailed past it and the run
  // overwrote every summary with the fallback. Probe the live AI once up front:
  // resummarizeThread now skips the write on a fallback, but a probe lets us
  // abort the WHOLE run instead of churning N no-op "failures". Any real
  // provider source ⇒ proceed; a fallback (source null/absent) ⇒ exit(1).
  const probe = await aiService.updateThreadSummary({
    displayName: "Probe",
    previousOpenLoops: [],
    previousRemember: [],
    messages: [{ direction: "IN", text: "ping", timestamp: new Date().toISOString() }],
    needsReply: true
  });
  if (!probe.source || probe.source.providerId === null) {
    console.error(
      `[reassess-all] Live AI probe returned the FALLBACK (no provider produced output) — key present but provider unusable` +
        `${probe.source?.fellBackMessage ? `: ${probe.source.fellBackMessage}` : ""}. ` +
        `Aborting before any write so summaries are not flattened.`
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  const threads = await prisma.thread.findMany({
    // Default: EVERY thread, archived included. `--ids` scopes a verification
    // run to specific threads.
    where: targetIds ? { id: { in: targetIds } } : {},
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, platform: true, person: { select: { displayName: true } } },
    ...(limit ? { take: limit } : {})
  });

  console.log(
    `[reassess-all] DB=${process.env.DATABASE_URL}\n[reassess-all] reassessing ${threads.length} thread(s) at concurrency ${concurrency}${limit ? ` (limit ${limit})` : ""}${fromScratch ? " [from-scratch: dropping prior summaries]" : ""}…`
  );

  // FAIL-CLOSED gate. Overwriting the summary on every thread is destructive
  // (the more so with --from-scratch, which discards each prior summary first),
  // so a bare invocation is a DRY RUN: it reports the blast radius and writes
  // nothing. `--apply` performs the rewrite; an `--ids`-scoped verification run
  // is exempt because it only touches the handful of threads the operator named.
  if (!apply && !targetIds) {
    console.log(
      `[reassess-all] DRY RUN — would reassess and OVERWRITE the summary on ${threads.length} thread(s)` +
        `${fromScratch ? " (from-scratch: each prior summary/loops/remember dropped first)" : ""}. ` +
        `Nothing written. Re-run with --apply to perform the rewrite (or scope a test with --ids id1,id2).`
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  let done = 0;
  let ok = 0;
  const failures: Array<{ id: string; name: string; reason: string }> = [];
  const started = Date.now();

  // Simple fixed-size worker pool over the thread list.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < threads.length) {
      const i = cursor;
      cursor += 1;
      const t = threads[i];
      if (!t) continue;
      const outcome = await resummarizeWithRetry(deps, t.id, { fromScratch });
      done += 1;
      if (outcome.ok) {
        ok += 1;
      } else {
        failures.push({ id: t.id, name: t.person.displayName, reason: outcome.reason });
      }
      if (done % 10 === 0 || done === threads.length) {
        const rate = done / Math.max(1, (Date.now() - started) / 1000);
        console.log(`[reassess-all] ${done}/${threads.length} (ok=${ok}, failed=${failures.length}, ${rate.toFixed(1)}/s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`\n[reassess-all] DONE: ${ok}/${threads.length} reassessed in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  if (failures.length > 0) {
    console.log(`[reassess-all] ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f.id} (${f.name}): ${f.reason}`);
  }

  await prisma.$disconnect();
  process.exit(failures.length > 0 ? 2 : 0);
}

main().catch(async (err) => {
  console.error("[reassess-all] fatal:", err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
