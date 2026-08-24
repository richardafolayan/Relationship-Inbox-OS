#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DRAFT_THREAD_INDEX = "drafts_threadId_key";

export function hasCorrectDraftThreadIndex(database) {
  const index = database
    .prepare('PRAGMA index_list("drafts")')
    .all()
    .find((candidate) => candidate.name === DRAFT_THREAD_INDEX);
  if (!index || Number(index.unique) !== 1 || Number(index.partial) !== 0) return false;
  const columns = database
    .prepare(`PRAGMA index_info("${DRAFT_THREAD_INDEX}")`)
    .all()
    .map((column) => column.name);
  return columns.length === 1 && columns[0] === "threadId";
}

export function repairDraftUniqueness(database) {
  const draftsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")
    .get();
  if (!draftsTable) return { deletedDrafts: 0, indexCreated: false };

  const columns = new Set(
    database.prepare('PRAGMA table_info("drafts")').all().map((column) => column.name)
  );
  for (const required of ["id", "threadId", "text", "updatedAt", "createdAt"]) {
    if (!columns.has(required)) throw new Error(`Legacy drafts table is missing ${required}`);
  }

  return database.transaction(() => {
    const drafts = database
      .prepare('SELECT "id", "threadId", "text", "updatedAt", "createdAt" FROM "drafts"')
      .all()
      .sort((left, right) => {
        if (left.threadId !== right.threadId) return left.threadId < right.threadId ? -1 : 1;
        const leftMeaningful = left.text.trim().length > 0;
        const rightMeaningful = right.text.trim().length > 0;
        if (leftMeaningful !== rightMeaningful) return leftMeaningful ? -1 : 1;
        if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
        if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
        if (left.id === right.id) return 0;
        return left.id < right.id ? -1 : 1;
      });
    const deleteDraft = database.prepare('DELETE FROM "drafts" WHERE "id" = ?');
    let previousThreadId;
    let deletedDrafts = 0;
    for (const draft of drafts) {
      if (draft.threadId === previousThreadId) {
        deleteDraft.run(draft.id);
        deletedDrafts += 1;
      } else {
        previousThreadId = draft.threadId;
      }
    }

    const hadCorrectIndex = hasCorrectDraftThreadIndex(database);
    if (!hadCorrectIndex) {
      database.exec(`DROP INDEX IF EXISTS "${DRAFT_THREAD_INDEX}"`);
      database.exec(
        `CREATE UNIQUE INDEX "${DRAFT_THREAD_INDEX}" ON "drafts"("threadId")`
      );
    }
    if (!hasCorrectDraftThreadIndex(database)) {
      throw new Error("Draft thread uniqueness index could not be validated");
    }
    const duplicate = database
      .prepare(
        'SELECT "threadId" FROM "drafts" GROUP BY "threadId" HAVING COUNT(*) > 1 LIMIT 1'
      )
      .get();
    if (duplicate) throw new Error(`Duplicate draft remains for thread ${duplicate.threadId}`);

    return { deletedDrafts, indexCreated: !hadCorrectIndex };
  }).immediate();
}

function runCli() {
  const checkOnly = process.argv[2] === "--check";
  const databasePath = process.argv[checkOnly ? 3 : 2];
  if (!databasePath) throw new Error("Usage: repair-schema-data.mjs <database.sqlite>");
  if (!isAbsolute(databasePath)) throw new Error("SQLite database path must be absolute");

  const database = new Database(databasePath, { fileMustExist: true });
  try {
    if (checkOnly) {
      const draftsTable = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")
        .get();
      if (!draftsTable || !hasCorrectDraftThreadIndex(database)) process.exitCode = 2;
    } else {
      repairDraftUniqueness(database);
    }
  } finally {
    database.close();
  }
}

function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) runCli();
