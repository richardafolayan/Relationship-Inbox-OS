import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { deriveMechanicalWritingRules, validateMechanicalWritingRules } from "../services/ai-output-rules";
import type { OperatorProfile } from "../types/runtime";

interface CandidateRow {
  platform: string;
  needsReply: number;
  rollingSummary: string | null;
  whatTheyWant: string | null;
  openLoopsJson: string | null;
  replyBriefJson: string | null;
  suggestedRepliesJson: string | null;
  messageCount: number;
}

interface ReviewReport {
  schemaVersion: 1;
  generatedAt: string;
  reviewedThreads: number;
  cachedSuggestedReplyThreads: number;
  selectionBuckets: Record<string, number>;
  platforms: Record<string, number>;
  checks: Record<string, { passed: number; failed: number }>;
  privateContentEmitted: false;
}

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function addCheck(report: ReviewReport, key: string, passed: boolean): void {
  report.checks[key] ??= { passed: 0, failed: 0 };
  report.checks[key]![passed ? "passed" : "failed"] += 1;
}

function selectRepresentativeRows(rows: CandidateRow[], limit: number): Array<{ row: CandidateRow; bucket: string }> {
  const selections: Array<{ row: CandidateRow; bucket: string }> = [];
  const used = new Set<CandidateRow>();
  const take = (bucket: string, predicate: (row: CandidateRow) => boolean, count: number): void => {
    for (const row of rows) {
      if (selections.length >= limit || count <= 0) break;
      if (used.has(row) || !predicate(row)) continue;
      used.add(row);
      selections.push({ row, bucket });
      count -= 1;
    }
  };
  take("short", (row) => row.messageCount <= 4, 2);
  take("long", (row) => row.messageCount >= 20, 2);
  take("pending", (row) => row.needsReply === 1, 2);
  take("already_replied", (row) => row.needsReply === 0, 2);
  take(
    "multi_action",
    (row) => {
      const brief = parseJson<{ required_points?: unknown[] }>(row.replyBriefJson, {});
      return Array.isArray(brief.required_points) && brief.required_points.length >= 2;
    },
    2
  );
  take("medium", (row) => row.messageCount > 4 && row.messageCount < 20, limit);
  return selections;
}

function main(): void {
  const dbPath = argumentValue("--db");
  if (!dbPath) throw new Error("--db is required");
  const limit = Math.max(1, Math.min(20, Number(argumentValue("--limit") ?? 10)));
  const outputPath = argumentValue("--output");
  const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT
      t.platform,
      t.needsReply,
      t.rollingSummary,
      t.whatTheyWant,
      t.openLoopsJson,
      t.replyBriefJson,
      t.suggestedRepliesJson,
      COUNT(m.id) AS messageCount
    FROM threads t
    LEFT JOIN messages m ON m.threadId = t.id
    WHERE t.archivedAt IS NULL
      AND t.rollingSummary IS NOT NULL
    GROUP BY t.id
    ORDER BY t.updatedAt DESC
    LIMIT 250
  `).all() as CandidateRow[];
  const profileRow = db.prepare("SELECT valueJson FROM settings WHERE key = ?").get("operator_profile_v1") as
    | { valueJson: string }
    | undefined;
  db.close();

  const operatorProfile = parseJson<OperatorProfile | null>(profileRow?.valueJson ?? null, null);
  const mechanicalRules = deriveMechanicalWritingRules(operatorProfile);
  const selections = selectRepresentativeRows(rows, limit);
  const report: ReviewReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reviewedThreads: selections.length,
    cachedSuggestedReplyThreads: 0,
    selectionBuckets: {},
    platforms: {},
    checks: {},
    privateContentEmitted: false
  };

  for (const { row, bucket } of selections) {
    report.selectionBuckets[bucket] = (report.selectionBuckets[bucket] ?? 0) + 1;
    report.platforms[row.platform] = (report.platforms[row.platform] ?? 0) + 1;
    const brief = parseJson<Record<string, unknown> | null>(row.replyBriefJson, null);
    const suggested = parseJson<{ replies?: Array<{ label?: string; text?: string }> } | null>(
      row.suggestedRepliesJson,
      null
    );
    const openLoops = parseJson<unknown[]>(row.openLoopsJson, []);
    const visibleSummary = `${row.rollingSummary ?? ""}\n${row.whatTheyWant ?? ""}\n${row.replyBriefJson ?? ""}`;
    const replies = Array.isArray(suggested?.replies) ? suggested.replies : [];

    addCheck(report, "summary_present", Boolean(row.rollingSummary?.trim() && row.whatTheyWant?.trim()));
    addCheck(report, "reply_brief_valid_json", brief !== null);
    addCheck(report, "open_loops_valid_json", Array.isArray(openLoops));
    addCheck(report, "no_ui_dashes", !/[—–]/u.test(visibleSummary));
    addCheck(report, "no_banned_coaching_language", !/(?:deepen the connection|grounded question|helpful nudge|build rapport)/iu.test(visibleSummary));
    if (row.suggestedRepliesJson !== null) {
      report.cachedSuggestedReplyThreads += 1;
      addCheck(report, "suggested_replies_valid_json", suggested !== null);
    }
    if (suggested !== null && row.suggestedRepliesJson !== null) {
      addCheck(report, "suggested_reply_count", replies.length === 0 || replies.length === 3);
      addCheck(
        report,
        "suggested_reply_shape",
        replies.every(
          (reply) =>
            typeof reply.text === "string" &&
            reply.text.trim().length > 0 &&
            reply.text.length <= 280 &&
            reply.label !== undefined &&
            ["A", "B", "C"].includes(reply.label)
        )
      );
      addCheck(
        report,
        "configured_mechanical_rules",
        replies.every(
          (reply) =>
            typeof reply.text !== "string" ||
            validateMechanicalWritingRules(reply.text, mechanicalRules).length === 0
        )
      );
    }
  }

  if (outputPath) {
    const absolute = resolve(outputPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[local-ai-review] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
