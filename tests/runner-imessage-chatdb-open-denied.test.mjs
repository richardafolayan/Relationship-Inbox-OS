import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { IMessageAdapter } from "../apps/runner/dist/platforms/imessage-adapter.js";

// A denied open on ~/Library/Messages/chat.db (no Full Disk Access, or a
// runner launched from a sandboxed shell) surfaces from better-sqlite3 as
// SqliteError { code: "SQLITE_CANTOPEN", message: "unable to open database
// file" }. The code lives on error.code, NOT in the message, so the old
// String(error) match misclassified real permission denials as generic open
// failures and the operator saw a raw sqlite message instead of the Full
// Disk Access guidance (2026-06-11 outage). chmod 000 on a real db file
// reproduces the exact same error without touching TCC.

test("chat.db permission denial surfaces the Full Disk Access guidance", { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root opens chmod-000 files" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "imsg-cantopen-"));
  const dbPath = join(dir, "chat.db");
  try {
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE chat (ROWID INTEGER PRIMARY KEY)");
    seed.close();
    chmodSync(dbPath, 0o000);

    const adapter = new IMessageAdapter({ dbPath, useAddressBook: false });
    await assert.rejects(
      () => adapter.ensureConnected(),
      (error) => {
        assert.equal(error.name, "AdapterFailure");
        assert.equal(error.kind, "AUTH_REQUIRED");
        assert.equal(error.details?.code, "SQLITE_CANTOPEN");
        assert.match(error.message, /Full Disk Access/);
        return true;
      }
    );
  } finally {
    try {
      chmodSync(dbPath, 0o644);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing chat.db still reports not-found, not the permission hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imsg-missing-"));
  try {
    const adapter = new IMessageAdapter({ dbPath: join(dir, "chat.db"), useAddressBook: false });
    await assert.rejects(
      () => adapter.ensureConnected(),
      (error) => {
        assert.equal(error.name, "AdapterFailure");
        assert.match(error.message, /not found/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
