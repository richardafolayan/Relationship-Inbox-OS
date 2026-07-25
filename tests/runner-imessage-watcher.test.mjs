import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createIMessageWatcher } from "../apps/runner/dist/services/imessage-watcher.js";

function setupTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "imw-"));
  const dbPath = join(dir, "chat.db");
  writeFileSync(dbPath, "");
  writeFileSync(`${dbPath}-wal`, "");
  return { dir, dbPath };
}

test("watcher fires once per debounced burst of writes", async () => {
  const { dir, dbPath } = setupTempDb();
  const fires = [];
  const logs = [];

  const watcher = createIMessageWatcher({
    dbPath,
    debounceMs: 80,
    pollIntervalMs: 30,
    onChange: (change) => fires.push(change),
    log: (line) => logs.push(line)
  });

  try {
    watcher.start();
    // fs.watch arms asynchronously; give it a tick before touching.
    await delay(30);

    appendFileSync(`${dbPath}-wal`, "a");
    appendFileSync(`${dbPath}-wal`, "b");
    appendFileSync(`${dbPath}-wal`, "c");

    await delay(250);

    assert.equal(fires.length, 1, `expected 1 debounced fire, got ${fires.length}`);
    assert.equal(fires[0].reason, "chat.db-wal");
    assert.equal(Number.isFinite(Date.parse(fires[0].sourceChangedAt)), true);
  } finally {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop cancels a pending debounced fire", async () => {
  const { dir, dbPath } = setupTempDb();
  const fires = [];

  const watcher = createIMessageWatcher({
    dbPath,
    debounceMs: 200,
    onChange: (change) => fires.push(change),
    log: () => {}
  });

  try {
    watcher.start();
    await delay(30);
    appendFileSync(`${dbPath}-wal`, "x");
    await delay(30);
    watcher.stop();
    await delay(300);
    assert.equal(fires.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("polling fallback catches WAL writes when directory events are unavailable", async () => {
  const { dir, dbPath } = setupTempDb();
  const fires = [];

  const watcher = createIMessageWatcher({
    dbPath,
    debounceMs: 60,
    pollIntervalMs: 30,
    directoryWatchEnabled: false,
    onChange: (change) => fires.push(change),
    log: () => {}
  });

  try {
    watcher.start();
    await delay(60);
    appendFileSync(`${dbPath}-wal`, "fallback");
    await delay(220);

    assert.equal(fires.length, 1);
    assert.equal(fires[0].reason, "chat.db-wal");
    assert.equal(Number.isFinite(Date.parse(fires[0].sourceChangedAt)), true);
  } finally {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
