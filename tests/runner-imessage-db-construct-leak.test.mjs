import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IMessageDb } from "../apps/runner/dist/platforms/imessage-db.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Regression test for the LOW finding P1-L4: the IMessageDb constructor opened
// the SQLite handle, then ran `pragma('journal_mode = WAL')` and a smoke-test
// `SELECT 1 FROM chat LIMIT 1`. If either threw (locked db, missing/unreadable
// `chat` table, partially-revoked Full Disk Access) the error propagated with
// the underlying connection still OPEN, and the half-constructed instance was
// never returned, so the caller had no handle to close. getDb() re-runs on
// every scan poll, so each failed open leaked one SQLite connection / fd.
//
// We reproduce the throw deterministically: seed a readonly db file that opens
// fine but has NO `chat` table, so the smoke-test's `SELECT 1 FROM chat` throws
// SQLITE_ERROR. The fix wraps the pragma + smoke-test in try/catch that closes
// the handle before rethrowing. We observe the close via the constructor's
// test seam `IMessageDb.onConstructError`, which receives the handle AFTER it
// has been closed - so `handle.open` must be false. Before the fix the seam is
// never invoked (and the handle stays open), so this test fails.
test("IMessageDb constructor closes the SQLite handle when the smoke-test throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "imessage-db-leak-"));
  const dbPath = join(dir, "chat.db");
  try {
    // Seed a db that is already in WAL mode (so the readonly WAL pragma is a
    // no-op success) but is missing the `chat` table the smoke-test reads.
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    seed.exec("CREATE TABLE other(id INTEGER)");
    seed.close();

    let capturedHandle = null;
    IMessageDb.onConstructError = (handle) => {
      capturedHandle = handle;
    };

    try {
      assert.throws(
        () => new IMessageDb(dbPath),
        /no such table: chat/,
        "the smoke-test should surface the missing-table error"
      );

      assert.ok(
        capturedHandle,
        "constructor must run its error-cleanup seam on a failed open"
      );
      assert.equal(
        capturedHandle.open,
        false,
        "the SQLite handle must be closed before the constructor rethrows (no fd leak)"
      );
    } finally {
      IMessageDb.onConstructError = undefined;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
