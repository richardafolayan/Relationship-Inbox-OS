import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("schema preparation creates a consistent SQLite backup before db push", () => {
  const root = mkdtempSync(join(tmpdir(), "tovi-schema-backup-"));
  const source = join(root, "source.sqlite");
  const destination = join(root, "backups", "copy.sqlite");
  const database = new Database(source);
  database.exec("CREATE TABLE pilot (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pilot(value) VALUES ('kept')");
  database.close();

  try {
    execFileSync(process.execPath, [
      resolve("scripts/lib/backup-sqlite.mjs"),
      source,
      destination
    ]);
    const backup = new Database(destination, { readonly: true });
    assert.deepEqual(backup.prepare("SELECT value FROM pilot").all(), [{ value: "kept" }]);
    backup.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the launcher refuses a schema change when the backup step fails", () => {
  const source = readFileSync(new URL("../scripts/start-app.mjs", import.meta.url), "utf8");
  const preparation = source.slice(source.indexOf("function prepare()"), source.indexOf("function delay("));
  const backupAt = preparation.indexOf("backupDatabaseBeforeSchemaChange(schemaHash)");
  const repairAt = preparation.indexOf("repairDatabaseBeforeSchemaChange()");
  const syncAt = preparation.indexOf("syncDatabase()");
  assert.ok(backupAt >= 0 && repairAt > backupAt && syncAt > repairAt);
  assert.match(preparation, /if \(!backupDatabaseBeforeSchemaChange\(schemaHash\)\) return \{ ok: false \}/);
  assert.match(source, /No schema change was applied/);
});
