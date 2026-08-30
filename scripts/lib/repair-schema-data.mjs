#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DRAFT_THREAD_INDEX = "drafts_threadId_key";
const SEND_SOURCE_COLUMN = "source";
const SEND_DRAFT_CONSUMED_COLUMN = "draftConsumed";
const SEND_RECOVERY_PREDECESSOR_COLUMN = "recoveryPredecessorClientSendId";
const SEND_RECOVERY_PREDECESSOR_INDEX =
  "send_requests_recoveryPredecessorClientSendId_key";
const SEND_SOURCE_REPAIR_MARKER_ID = "data_repair_send_request_source_v2";
const SEND_SOURCE_REPAIR_MARKER_KEY = "data_repair_send_request_source_v2";
const SEND_SOURCE_REPAIR_MARKER_VALUE = '{"version":2}';

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

export function hasSendRequestSourceColumn(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  if (!sendRequestsTable) return false;
  const column = database
    .prepare('PRAGMA table_info("send_requests")')
    .all()
    .find((candidate) => candidate.name === SEND_SOURCE_COLUMN);
  return Boolean(
    column &&
      String(column.type).toUpperCase() === "TEXT" &&
      Number(column.notnull) === 1 &&
      (column.dflt_value === null ||
        ["'manual'", "'legacy_unknown'"].includes(
          String(column.dflt_value).replaceAll('"', "'")
        ))
  );
}

export function hasSendRequestDraftConsumedColumn(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  if (!sendRequestsTable) return false;
  const column = database
    .prepare('PRAGMA table_info("send_requests")')
    .all()
    .find((candidate) => candidate.name === SEND_DRAFT_CONSUMED_COLUMN);
  return Boolean(
    column &&
      String(column.type).toUpperCase() === "BOOLEAN" &&
      Number(column.notnull) === 1 &&
      ["false", "0"].includes(String(column.dflt_value).toLowerCase())
  );
}

export function hasSendRequestRecoveryPredecessorColumn(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  if (!sendRequestsTable) return false;
  const column = database
    .prepare('PRAGMA table_info("send_requests")')
    .all()
    .find((candidate) => candidate.name === SEND_RECOVERY_PREDECESSOR_COLUMN);
  return Boolean(
    column &&
      String(column.type).toUpperCase() === "TEXT" &&
      Number(column.notnull) === 0
  );
}

export function hasSendRequestRecoveryPredecessorIndex(database) {
  const index = database
    .prepare('PRAGMA index_list("send_requests")')
    .all()
    .find((candidate) => candidate.name === SEND_RECOVERY_PREDECESSOR_INDEX);
  if (!index || Number(index.unique) !== 1 || Number(index.partial) !== 0) {
    return false;
  }
  const columns = database
    .prepare(`PRAGMA index_info("${SEND_RECOVERY_PREDECESSOR_INDEX}")`)
    .all()
    .map((column) => column.name);
  return columns.length === 1 && columns[0] === SEND_RECOVERY_PREDECESSOR_COLUMN;
}

export function repairSendRequestRecoveryPredecessorColumn(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  if (!sendRequestsTable) return { columnAdded: false };
  const existingColumn = database
    .prepare('PRAGMA table_info("send_requests")')
    .all()
    .find((candidate) => candidate.name === SEND_RECOVERY_PREDECESSOR_COLUMN);
  if (existingColumn && !hasSendRequestRecoveryPredecessorColumn(database)) {
    throw new Error("Existing send recovery predecessor column is incompatible");
  }
  return database.transaction(() => {
    const columnAdded = !existingColumn;
    if (columnAdded) {
      database.exec(
        'ALTER TABLE "send_requests" ADD COLUMN "recoveryPredecessorClientSendId" TEXT'
      );
    }
    if (!hasSendRequestRecoveryPredecessorColumn(database)) {
      throw new Error("Send recovery predecessor column could not be validated");
    }

    const duplicatePredecessors = database
      .prepare(`
        SELECT "${SEND_RECOVERY_PREDECESSOR_COLUMN}" AS "predecessorId"
        FROM "send_requests"
        WHERE "${SEND_RECOVERY_PREDECESSOR_COLUMN}" IS NOT NULL
        GROUP BY "${SEND_RECOVERY_PREDECESSOR_COLUMN}"
        HAVING COUNT(*) > 1
      `)
      .all();
    let duplicateSuccessorsBlocked = 0;
    if (duplicatePredecessors.length > 0) {
      const columns = new Set(
        database
          .prepare('PRAGMA table_info("send_requests")')
          .all()
          .map((column) => column.name)
      );
      for (const required of ["id", "status", "errorJson"]) {
        if (!columns.has(required)) {
          throw new Error(
            `Send request recovery lineage repair requires ${required}`
          );
        }
      }
      const clearTerminalDuplicate = database.prepare(`
        UPDATE "send_requests"
        SET "${SEND_RECOVERY_PREDECESSOR_COLUMN}" = NULL
        WHERE "id" = ?
      `);
      const blockUnresolvedDuplicate = database.prepare(`
        UPDATE "send_requests"
        SET
          "status" = 'FAILED',
          "errorJson" = ?,
          "${SEND_RECOVERY_PREDECESSOR_COLUMN}" = NULL
        WHERE "id" = ?
      `);
      for (const { predecessorId } of duplicatePredecessors) {
        const successors = database
          .prepare(`
            SELECT "id", "status"
            FROM "send_requests"
            WHERE "${SEND_RECOVERY_PREDECESSOR_COLUMN}" = ?
            ORDER BY CASE WHEN "status" = 'SENT' THEN 0 ELSE 1 END, "id" ASC
          `)
          .all(predecessorId);
        for (const successor of successors.slice(1)) {
          if (successor.status === "SENT") {
            clearTerminalDuplicate.run(successor.id);
          } else {
            blockUnresolvedDuplicate.run(
              JSON.stringify({
                errorKind: "DELIVERY_UNCERTAIN",
                message:
                  "Another recovered send already claimed this predecessor",
                reasonCode: "recovery_predecessor_already_claimed"
              }),
              successor.id
            );
          }
          duplicateSuccessorsBlocked += 1;
        }
      }
    }

    const hadCorrectIndex = hasSendRequestRecoveryPredecessorIndex(database);
    if (!hadCorrectIndex) {
      database.exec(`DROP INDEX IF EXISTS "${SEND_RECOVERY_PREDECESSOR_INDEX}"`);
      database.exec(
        `CREATE UNIQUE INDEX "${SEND_RECOVERY_PREDECESSOR_INDEX}" ON "send_requests"("${SEND_RECOVERY_PREDECESSOR_COLUMN}")`
      );
    }
    if (!hasSendRequestRecoveryPredecessorIndex(database)) {
      throw new Error("Send recovery predecessor uniqueness could not be validated");
    }
    return {
      columnAdded,
      duplicateSuccessorsBlocked,
      indexCreated: !hadCorrectIndex
    };
  }).immediate();
}

function sendRequestSourceRepairMarker(database) {
  const settingsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get();
  if (!settingsTable) return null;
  return database
    .prepare('SELECT "id", "valueJson" FROM "settings" WHERE "key" = ?')
    .get(SEND_SOURCE_REPAIR_MARKER_KEY) ?? null;
}

export function hasSendRequestSourceRepairMarker(database) {
  const marker = sendRequestSourceRepairMarker(database);
  return Boolean(
    marker &&
      marker.id === SEND_SOURCE_REPAIR_MARKER_ID &&
      marker.valueJson === SEND_SOURCE_REPAIR_MARKER_VALUE
  );
}

export function sendRequestSourceRequiresRepair(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  return Boolean(sendRequestsTable) &&
    (!hasSendRequestSourceColumn(database) || !hasSendRequestSourceRepairMarker(database));
}

export function repairSendRequestSource(database) {
  const sendRequestsTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'send_requests'")
    .get();
  if (!sendRequestsTable) {
    return { columnAdded: false, legacyRowsMarkedUnknown: 0, markerAdded: false };
  }

  return database.transaction(() => {
    const settingsColumns = new Set(
      database.prepare('PRAGMA table_info("settings")').all().map((column) => column.name)
    );
    for (const required of ["id", "key", "valueJson", "createdAt", "updatedAt"]) {
      if (!settingsColumns.has(required)) {
        throw new Error(`Settings table is missing ${required} for source repair marker`);
      }
    }

    const marker = sendRequestSourceRepairMarker(database);
    if (
      marker &&
      (marker.id !== SEND_SOURCE_REPAIR_MARKER_ID ||
        marker.valueJson !== SEND_SOURCE_REPAIR_MARKER_VALUE)
    ) {
      throw new Error("Existing send request source repair marker is malformed");
    }

    const existingColumn = database
      .prepare('PRAGMA table_info("send_requests")')
      .all()
      .find((candidate) => candidate.name === SEND_SOURCE_COLUMN);
    const columnAdded = !existingColumn;
    if (existingColumn && !hasSendRequestSourceColumn(database)) {
      throw new Error("Existing send request source column has an incompatible definition");
    }
    if (marker) {
      if (!hasSendRequestSourceColumn(database)) {
        throw new Error("Send request source repair marker exists without a compatible column");
      }
      return { columnAdded: false, legacyRowsMarkedUnknown: 0, markerAdded: false };
    }

    if (columnAdded) {
      database.exec(
        'ALTER TABLE "send_requests" ADD COLUMN "source" TEXT NOT NULL DEFAULT \'legacy_unknown\''
      );
    }
    const legacyRowsMarkedUnknown = database
      .prepare('UPDATE "send_requests" SET "source" = ?')
      .run("legacy_unknown").changes;
    const now = Date.now();
    database
      .prepare(`
        INSERT INTO "settings" (
          "id", "key", "valueJson", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        SEND_SOURCE_REPAIR_MARKER_ID,
        SEND_SOURCE_REPAIR_MARKER_KEY,
        SEND_SOURCE_REPAIR_MARKER_VALUE,
        now,
        now
      );
    if (!hasSendRequestSourceColumn(database)) {
      throw new Error("Send request source column could not be validated");
    }
    if (!hasSendRequestSourceRepairMarker(database)) {
      throw new Error("Send request source repair marker could not be validated");
    }
    return {
      columnAdded,
      legacyRowsMarkedUnknown,
      markerAdded: true
    };
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
      if (
        !draftsTable ||
        !hasCorrectDraftThreadIndex(database) ||
        sendRequestSourceRequiresRepair(database) ||
        !hasSendRequestDraftConsumedColumn(database) ||
        !hasSendRequestRecoveryPredecessorColumn(database) ||
        !hasSendRequestRecoveryPredecessorIndex(database)
      ) {
        process.exitCode = 2;
      }
    } else {
      repairDraftUniqueness(database);
      repairSendRequestSource(database);
      repairSendRequestRecoveryPredecessorColumn(database);
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
