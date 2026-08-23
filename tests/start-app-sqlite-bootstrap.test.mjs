import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSqliteDatabaseFile } from "../scripts/lib/sqlite-database.mjs";

test("a completely absent packaged database is created before Prisma runs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tovi-first-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "Application Support", "Relationship Inbox OS", "data");
  const databasePath = join(dataDir, "inbox-os.sqlite");

  const result = prepareSqliteDatabaseFile(`file:${databasePath}`, {
    appDir: "/signed/Tovi.app/Contents/Resources/app",
    dataDir
  });

  assert.equal(result.created, true);
  assert.equal(result.databasePath, databasePath);
  assert.equal(result.databaseUrl, `file:${databasePath}`);
  assert.equal(statSync(databasePath).size, 0);
  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
});

test("bootstrap never truncates or changes an existing pilot database", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tovi-existing-database-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "data", "inbox-os.sqlite");
  const first = prepareSqliteDatabaseFile(`file:${databasePath}`, {
    appDir: root,
    dataDir: join(root, "data")
  });
  writeFileSync(databasePath, "existing-pilot-data");

  const second = prepareSqliteDatabaseFile(`file:${databasePath}`, {
    appDir: root,
    dataDir: join(root, "data")
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(readFileSync(databasePath, "utf8"), "existing-pilot-data");
});

test("relative SQLite URLs are normalised to the app root before schema push", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tovi-relative-database-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = prepareSqliteDatabaseFile(" file:./data/inbox-os.sqlite?connection_limit=1 ", {
    appDir: root,
    dataDir: join(root, "fallback")
  });

  assert.equal(result.databasePath, join(root, "data", "inbox-os.sqlite"));
  assert.equal(result.databaseUrl, `file:${join(root, "data", "inbox-os.sqlite")}?connection_limit=1`);
  assert.equal(statSync(result.databasePath).size, 0);
});

test("non-file datasource URLs are passed through without filesystem writes", () => {
  const result = prepareSqliteDatabaseFile("libsql://example.invalid/db", {
    appDir: "/app",
    dataDir: "/data"
  });

  assert.deepEqual(result, {
    created: false,
    databasePath: null,
    databaseUrl: "libsql://example.invalid/db"
  });
});
