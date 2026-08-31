import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptionService } from "../apps/runner/dist/services/transcription/index.js";

// Regression for H3: a fast queue task that THROWS (e.g. SQLITE_BUSY under
// a concurrent scan) used to leak the pre-marked `standard` tier forever.
//
// enqueueMessage marks BOTH `fast` and `standard` pending but only queues
// `fast`; the `standard` tracking is normally cleared by
// runOneTierForQueue's completion path. When runOneProgressiveTier THROWS,
// that path is bypassed and the drain catch only cleared `fast`. The
// leaked `{standard}` entry then (1) kept the dashboard's `isImproving`
// hint true forever and (2) made the de-dupe guard
// (`pendingTiersByMessage.has(messageId)`) skip every future auto-enqueue.
//
// The fix clears ALL tracked tiers for the message in the drain catch.

function makeFakePrisma() {
  const parentRows = new Map();
  const attemptRows = [];
  let parentCounter = 0;
  let attemptCounter = 0;
  const database = {
    parentRows,
    attemptRows,
    message: {
      _messages: [],
      async findUnique({ where }) {
        return this._messages.find((m) => m.id === where.id) ?? null;
      }
    },
    messageAudioTranscription: {
      async findUnique({ where }) {
        if (where.messageId !== undefined) {
          return parentRows.get(where.messageId) ?? null;
        }
        for (const row of parentRows.values()) {
          if (where.id !== undefined && row.id === where.id) return row;
        }
        return null;
      },
      async create({ data }) {
        parentCounter += 1;
        const row = { id: `t-${parentCounter}`, ...data };
        parentRows.set(data.messageId, row);
        return row;
      },
      async update({ where, data }) {
        let row = null;
        if (where.id !== undefined) {
          for (const r of parentRows.values()) if (r.id === where.id) row = r;
        }
        if (!row && where.messageId !== undefined) {
          row = parentRows.get(where.messageId) ?? null;
        }
        if (!row) throw new Error("update: not found");
        Object.assign(row, data);
        return row;
      },
      async delete({ where }) {
        const row = parentRows.get(where.messageId);
        if (!row) throw new Error("delete: not found");
        parentRows.delete(where.messageId);
        for (let i = attemptRows.length - 1; i >= 0; i -= 1) {
          if (attemptRows[i].transcriptionId === row.id) attemptRows.splice(i, 1);
        }
        return row;
      }
    },
    messageAudioTranscriptionAttempt: {
      async create({ data }) {
        attemptCounter += 1;
        const row = { id: `a-${attemptCounter}`, ...data };
        attemptRows.push(row);
        return row;
      },
      async upsert({ where, update, create }) {
        const key = where.transcriptionId_tier_model;
        const existing = attemptRows.find(
          (row) =>
            row.transcriptionId === key.transcriptionId &&
            row.tier === key.tier &&
            row.model === key.model
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        attemptCounter += 1;
        const row = { id: `a-${attemptCounter}`, ...create };
        attemptRows.push(row);
        return row;
      },
      async findFirst({ where } = {}) {
        return (
          attemptRows.find(
            (a) =>
              (where?.transcriptionId === undefined ||
                a.transcriptionId === where.transcriptionId) &&
              (where?.tier === undefined || a.tier === where.tier) &&
              (where?.model === undefined || a.model === where.model)
          ) ?? null
        );
      },
      async findMany({ where } = {}) {
        if (where?.transcriptionId) {
          return attemptRows.filter((a) => a.transcriptionId === where.transcriptionId);
        }
        return [...attemptRows];
      }
    },
    async $transaction(work) {
      return work(database);
    }
  };
  return database;
}

function makeMessage(id, key) {
  return {
    id,
    platformMessageKey: key,
    threadId: "t-1",
    direction: "IN",
    attachmentsJson: JSON.stringify([
      { type: "voice_note", manualReview: false, kind: "voice_note", guid: `g-${id}` }
    ])
  };
}

function makeAudioFile() {
  const dir = mkdtempSync(join(tmpdir(), "audio-drain-throw-"));
  const path = join(dir, "voice.m4a");
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  return path;
}

function makeResolver(path) {
  return {
    async resolve() {
      return {
        absolutePath: path,
        mimeType: "audio/mp4",
        filename: "v.m4a",
        transferName: "v.m4a"
      };
    }
  };
}

function okProvider(id, label, text) {
  const calls = [];
  return {
    calls,
    provider: {
      id,
      modelLabel: label,
      async transcribe(req) {
        calls.push({ at: Date.now(), req });
        return { kind: "ok", result: { text: `${text} for ${req.filePath}`, model: label } };
      }
    }
  };
}

const baseConfig = {
  enabled: true,
  apiKey: null,
  model: "gpt-4o-mini-transcribe",
  language: "en",
  maxBytes: 25 * 1024 * 1024,
  maxSeconds: 600
};

test("a throwing fast queue task clears ALL tracked tiers (no standard leak)", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));

  // Fast provider throws on its first call — simulates an exception
  // (e.g. SQLITE_BUSY surfacing) DURING the fast pass. Distinct from a
  // graceful `{kind:"failed"}` return, which the non-throw path already
  // handles.
  let fastCalls = 0;
  const fastThrows = {
    provider: {
      id: "local-whisper",
      modelLabel: "f",
      async transcribe() {
        fastCalls += 1;
        if (fastCalls === 1) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return { kind: "ok", result: { text: "fast recovered", model: "f" } };
      }
    }
  };
  const standard = okProvider("local-whisper", "s", "standard");

  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fastThrows.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });

  // Both tiers are pre-marked pending at enqueue time.
  service.enqueueMessage("m1");
  assert.deepEqual(
    service.getPendingTiers("m1").sort(),
    ["fast", "standard"],
    "fast + standard pre-marked pending at enqueue"
  );

  // Let the queue drain. The fast task throws.
  await new Promise((r) => setTimeout(r, 100));

  // CORE ASSERTION: after the throw, NOTHING is pending. Before the fix
  // this was ["standard"] — leaked forever, freezing the dashboard's
  // "Improving…" hint.
  assert.deepEqual(
    service.getPendingTiers("m1"),
    [],
    "throwing fast task must not leak the standard tier"
  );
  assert.equal(fastCalls, 1, "fast attempted exactly once on the first enqueue");
  assert.equal(standard.calls.length, 0, "standard must not run after a fast throw");
});

test("after a throwing fast task, a future auto-enqueue is no longer blocked", async () => {
  const audioPath = makeAudioFile();
  const prisma = makeFakePrisma();
  prisma.message._messages.push(makeMessage("m1", "k1"));

  let fastCalls = 0;
  const fast = {
    provider: {
      id: "local-whisper",
      modelLabel: "f",
      async transcribe() {
        fastCalls += 1;
        if (fastCalls === 1) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return { kind: "ok", result: { text: "fast recovered", model: "f" } };
      }
    }
  };
  const standard = okProvider("local-whisper", "s", "standard");

  const service = createTranscriptionService({
    prisma,
    provider: null,
    providers: { fast: fast.provider, standard: standard.provider },
    attachmentResolver: makeResolver(audioPath),
    config: baseConfig,
    warn: () => {}
  });

  // First enqueue: fast throws.
  service.enqueueMessage("m1");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fastCalls, 1, "first fast attempt threw");

  // A later scan re-enqueues the same message. Before the fix the leaked
  // `{standard}` made the de-dupe guard skip this enqueue entirely, so
  // the message could never be picked up again automatically.
  service.enqueueMessage("m1");
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(
    fastCalls,
    2,
    "second auto-enqueue must run a fresh fast attempt (de-dupe guard cleared)"
  );
  // The recovered fast pass then chains standard, completing the chain.
  assert.equal(standard.calls.length, 1, "standard runs once the retry fast succeeds");
  assert.deepEqual(service.getPendingTiers("m1"), [], "nothing pending after a clean re-run");
});
