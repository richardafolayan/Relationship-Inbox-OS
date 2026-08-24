import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const {
  MIGRATION_MARKER,
  prepareLegacyStorageMigration,
  readMigrationState,
  writeMigrationState
} = require("../apps/desktop/legacy-storage-migration.cjs");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_SCRIPT = join(ROOT, "scripts", "lib", "backup-sqlite.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tovi-legacy-migration-"));
  const paths = {
    configDir: join(root, "config"),
    dataDir: join(root, "config", "data"),
    stateDir: join(root, "config", "state"),
    legacyDir: join(root, "legacy")
  };
  mkdirSync(join(paths.legacyDir, "data"), { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  return {
    root,
    paths,
    source: join(paths.legacyDir, "data", "inbox-os.sqlite"),
    target: join(paths.dataDir, "inbox-os.sqlite"),
    marker: join(paths.stateDir, MIGRATION_MARKER),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function createDatabase(path, value) {
  const database = new Database(path);
  database.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  database.prepare("INSERT INTO messages (body) VALUES (?)").run(value);
  database.close();
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function migrate(paths, decide, extra = {}) {
  return prepareLegacyStorageMigration({
    paths,
    decide,
    nodeExecutable: process.execPath,
    backupScript: BACKUP_SCRIPT,
    ...extra
  });
}

test("legacy import captures committed WAL rows without copying SQLite sidecars", async () => {
  const item = fixture();
  const source = new Database(item.source);
  try {
    source.pragma("journal_mode = WAL");
    source.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    source.prepare("INSERT INTO messages (body) VALUES (?)").run("committed in WAL");
    writeFileSync(join(item.paths.legacyDir, ".env"), "OPENAI_API_KEY=preserved\n");
    mkdirSync(join(item.paths.legacyDir, "data", "browser-profiles", "linkedin"), { recursive: true });
    writeFileSync(
      join(item.paths.legacyDir, "data", "browser-profiles", "linkedin", "session.json"),
      "connected"
    );
    mkdirSync(join(item.paths.legacyDir, "data", "runtime"), { recursive: true });
    writeFileSync(join(item.paths.legacyDir, "data", "runtime", "processes.json"), "stale");

    const result = await migrate(item.paths, async () => "import");
    assert.equal(result.decision, "imported");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.equal(existsSync(`${item.target}${suffix}`), false);
    }
    const target = new Database(item.target, { readonly: true });
    assert.deepEqual(target.prepare("SELECT body FROM messages").all(), [{ body: "committed in WAL" }]);
    assert.deepEqual(target.pragma("quick_check"), [{ quick_check: "ok" }]);
    target.close();
    assert.equal(readFileSync(join(item.paths.configDir, ".env"), "utf8"), "OPENAI_API_KEY=preserved\n");
    assert.equal(
      readFileSync(join(item.paths.dataDir, "browser-profiles", "linkedin", "session.json"), "utf8"),
      "connected"
    );
    assert.equal(existsSync(join(item.paths.dataDir, "runtime", "processes.json")), false);
  } finally {
    source.close();
    item.cleanup();
  }
});

test("a backup failure leaves a retryable import intent and never records completion", async () => {
  const item = fixture();
  try {
    createDatabase(item.source, "source");
    let decisions = 0;
    await assert.rejects(
      migrate(item.paths, async () => {
        decisions += 1;
        return "import";
      }, {
        runProcess(executable, args, options) {
          if (args[1] !== "--verify") return { status: 1, stderr: "injected backup failure" };
          return spawnSync(executable, args, options);
        }
      }),
      /injected backup failure/
    );
    assert.equal(decisions, 1);
    assert.deepEqual(readMigrationState(item.marker), {
      version: 2,
      phase: "importing",
      decision: "import",
      recordedAt: readMigrationState(item.marker).recordedAt
    });

    const resumed = await migrate(item.paths, async () => {
      decisions += 1;
      return "quit";
    });
    assert.equal(resumed.decision, "imported");
    assert.equal(decisions, 1, "retry must not ask the user to choose again");
  } finally {
    item.cleanup();
  }
});

test("retry completes a committed database import without copying the source again", async () => {
  const item = fixture();
  try {
    createDatabase(item.source, "source");
    spawnSync(process.execPath, [BACKUP_SCRIPT, item.source, item.target], { stdio: "inherit" });
    writeMigrationState(item.marker, {
      version: 2,
      phase: "importing",
      decision: "import",
      recordedAt: new Date().toISOString()
    });
    const sourceBefore = hash(item.source);
    let backupRuns = 0;
    const result = await migrate(item.paths, async () => {
      throw new Error("retry prompted unexpectedly");
    }, {
      runProcess(executable, args, options) {
        if (args[1] !== "--verify") backupRuns += 1;
        return spawnSync(executable, args, options);
      }
    });
    assert.equal(result.decision, "imported");
    assert.equal(backupRuns, 0);
    assert.equal(hash(item.source), sourceBefore);
    assert.equal(readMigrationState(item.marker).phase, "complete");
  } finally {
    item.cleanup();
  }
});

test("an invalid destination owned by an import intent is replaced from the verified source", async () => {
  const item = fixture();
  try {
    createDatabase(item.source, "source truth");
    writeFileSync(item.target, "truncated");
    writeMigrationState(item.marker, {
      version: 2,
      phase: "importing",
      decision: "import",
      recordedAt: new Date().toISOString()
    });
    await migrate(item.paths, async () => "quit");
    const target = new Database(item.target, { readonly: true });
    assert.deepEqual(target.prepare("SELECT body FROM messages").all(), [{ body: "source truth" }]);
    target.close();
  } finally {
    item.cleanup();
  }
});

test("a pending legacy schema restore is completed before the database is imported", async () => {
  const item = fixture();
  try {
    createDatabase(item.source, "original");
    const backup = join(item.paths.legacyDir, "data", "backups", "verified.sqlite");
    mkdirSync(dirname(backup), { recursive: true });
    const backedUp = spawnSync(process.execPath, [BACKUP_SCRIPT, item.source, backup], { encoding: "utf8" });
    assert.equal(backedUp.status, 0, backedUp.stderr);
    const source = new Database(item.source);
    source.prepare("UPDATE messages SET body = ?").run("valid but semantically partial");
    source.close();
    const recoveryMarker = join(
      item.paths.legacyDir,
      "data",
      "runtime",
      "database-recovery-required.json"
    );
    mkdirSync(dirname(recoveryMarker), { recursive: true });
    writeFileSync(recoveryMarker, JSON.stringify({ version: 1, backupPath: backup }));

    await migrate(item.paths, async () => "import");
    const target = new Database(item.target, { readonly: true });
    assert.deepEqual(target.prepare("SELECT body FROM messages").all(), [{ body: "original" }]);
    target.close();
    assert.equal(existsSync(recoveryMarker), false);
  } finally {
    item.cleanup();
  }
});

test("a pending no-prior-database recovery imports durable data and completes without a source database", async () => {
  const item = fixture();
  try {
    writeFileSync(item.source, "partial database");
    mkdirSync(join(item.paths.legacyDir, "data", "browser-profiles"), { recursive: true });
    writeFileSync(join(item.paths.legacyDir, "data", "browser-profiles", "session"), "connected");
    const recoveryMarker = join(
      item.paths.legacyDir,
      "data",
      "runtime",
      "database-recovery-required.json"
    );
    mkdirSync(dirname(recoveryMarker), { recursive: true });
    writeFileSync(recoveryMarker, JSON.stringify({
      version: 2,
      mode: "remove-created-database",
      databasePath: item.source
    }));

    const result = await migrate(item.paths, async () => "import");
    assert.equal(result.decision, "imported");
    assert.equal(existsSync(item.target), false);
    assert.equal(
      readFileSync(join(item.paths.dataDir, "browser-profiles", "session"), "utf8"),
      "connected"
    );
    assert.equal(readMigrationState(item.marker).phase, "complete");
  } finally {
    item.cleanup();
  }
});

test("an existing target without import intent is always authoritative", async () => {
  const item = fixture();
  try {
    createDatabase(item.source, "legacy");
    createDatabase(item.target, "current");
    let prompted = false;
    const result = await migrate(item.paths, async () => {
      prompted = true;
      return "import";
    });
    assert.equal(result.decision, "existing");
    assert.equal(prompted, false);
    const target = new Database(item.target, { readonly: true });
    assert.deepEqual(target.prepare("SELECT body FROM messages").all(), [{ body: "current" }]);
    target.close();
  } finally {
    item.cleanup();
  }
});

test("legacy terminal markers, fresh decisions and quit decisions are durable and compatible", async () => {
  for (const legacyDecision of ["imported", "fresh"]) {
    const item = fixture();
    try {
      createDatabase(item.source, "legacy");
      writeFileSync(item.marker, JSON.stringify({ decision: legacyDecision, recordedAt: "earlier" }));
      const result = await migrate(item.paths, async () => {
        throw new Error("legacy terminal marker prompted unexpectedly");
      });
      assert.equal(result.decision, legacyDecision);
    } finally {
      item.cleanup();
    }
  }

  const fresh = fixture();
  try {
    createDatabase(fresh.source, "legacy");
    assert.equal((await migrate(fresh.paths, async () => "fresh")).decision, "fresh");
    assert.equal((await migrate(fresh.paths, async () => {
      throw new Error("fresh decision prompted twice");
    })).decision, "fresh");
  } finally {
    fresh.cleanup();
  }

  const quit = fixture();
  try {
    createDatabase(quit.source, "legacy");
    assert.equal((await migrate(quit.paths, async () => "quit")).proceed, false);
    assert.equal(existsSync(quit.marker), false);
  } finally {
    quit.cleanup();
  }
});
