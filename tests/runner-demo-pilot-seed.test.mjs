import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  seedDemoData,
  cleanupDemoData,
  PILOT_TOUR_SERENA_THREAD_ID,
  PILOT_TOUR_TIMI_THREAD_ID
} = await import("../apps/runner/dist/services/demo.js");

// Tiny fake of the slice of Prisma the seeder touches. Records everything
// it sees so the test can assert against the rows that would have been
// inserted. Matches the DemoPrisma shape declared in demo.ts.
function createFakePrisma(initial = { threads: [] }) {
  const people = new Map();
  const threads = new Map();
  const messages = [];
  const auditLogs = new Map();
  // Pre-existing rows the test can plant to verify cleanup only removes
  // what the manifest tracked.
  for (const row of initial.threads) {
    threads.set(row.id, row);
  }
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${(counter += 1)}`;
  return {
    people,
    threads,
    messages,
    auditLogs,
    person: {
      async create({ data }) {
        const row = { id: nextId("p"), ...data };
        people.set(row.id, row);
        return row;
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        for (const id of ids) people.delete(id);
        return { count: ids.size };
      }
    },
    thread: {
      async create({ data }) {
        const row = { id: nextId("t"), ...data };
        threads.set(row.id, row);
        return row;
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        for (const id of ids) threads.delete(id);
        return { count: ids.size };
      }
    },
    message: {
      async createMany({ data }) {
        for (const row of data) messages.push(row);
        return { count: data.length };
      }
    },
    auditLog: {
      async create({ data }) {
        const row = { id: nextId("a"), ...data };
        auditLogs.set(row.id, row);
        return row;
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        for (const id of ids) auditLogs.delete(id);
        return { count: ids.size };
      }
    }
  };
}

async function withTmpDirs(callback) {
  const root = await mkdtemp(join(tmpdir(), "demo-pilot-test-"));
  const screenshotDir = join(root);
  const domDumpDir = join(root);
  return callback({ screenshotDir, domDumpDir });
}

test("pilot-guided-tour seed creates exactly Serena (IMESSAGE) and Timi (LINKEDIN)", async () => {
  await withTmpDirs(async ({ screenshotDir, domDumpDir }) => {
    const prisma = createFakePrisma();
    const manifest = await seedDemoData({
      mode: "pilot-guided-tour",
      screenshotDir,
      domDumpDir,
      prisma
    });

    // Exactly two threads, two people, no audit logs, no diagnostic files.
    assert.equal(manifest.mode, "pilot-guided-tour");
    assert.equal(manifest.threadIds.length, 2, "pilot seed should produce two threads");
    assert.equal(manifest.personIds.length, 2, "pilot seed should produce two people");
    assert.equal(manifest.logIds.length, 0, "pilot seed must not raise a fake degraded audit log");
    assert.equal(manifest.screenshotFiles.length, 0);
    assert.equal(manifest.domDumpFiles.length, 0);

    // The two threads carry the stable platformThreadIds the tour anchors on.
    const platformThreadIds = Array.from(prisma.threads.values())
      .map((t) => t.platformThreadId)
      .sort();
    assert.deepEqual(platformThreadIds, [
      PILOT_TOUR_SERENA_THREAD_ID,
      PILOT_TOUR_TIMI_THREAD_ID
    ].sort());

    // Per-thread shape checks.
    const serena = Array.from(prisma.threads.values()).find(
      (t) => t.platformThreadId === PILOT_TOUR_SERENA_THREAD_ID
    );
    const timi = Array.from(prisma.threads.values()).find(
      (t) => t.platformThreadId === PILOT_TOUR_TIMI_THREAD_ID
    );
    assert.equal(serena.platform, "IMESSAGE", "Serena thread must be on IMESSAGE");
    assert.equal(timi.platform, "LINKEDIN", "Timi thread must be on LINKEDIN");
    assert.equal(serena.needsReply, true);
    assert.equal(timi.needsReply, true);
    assert.ok(serena.openLoopsJson, "Serena thread should expose at least one open loop");
    assert.ok(timi.rollingSummary, "Timi thread should have a rolling summary for the 'catch me up' beat");

    // Messages should include the iMessage thread's last inbound — the
    // tour's Reply Brief story relies on Serena's ask landing as a
    // direct human reply rather than a placeholder.
    const serenaInbound = prisma.messages.filter(
      (m) => m.threadId === serena.id && m.direction === "IN"
    );
    assert.ok(serenaInbound.length >= 2, "Serena should have multiple inbound messages so the story has shape");

    // No tour artefact directory should have been written; the pilot
    // seed does not produce screenshot/DOM dump files.
    const files = await readdir(screenshotDir).catch(() => []);
    assert.equal(files.length, 0);
  });
});

test("cleanupDemoData only removes rows tracked in the manifest", async () => {
  await withTmpDirs(async ({ screenshotDir, domDumpDir }) => {
    // Seed an unrelated row first so we can verify cleanup leaves it alone.
    const prisma = createFakePrisma({
      threads: [
        { id: "real-thread", platform: "LINKEDIN", platformThreadId: "real-1", needsReply: true }
      ]
    });
    const manifest = await seedDemoData({
      mode: "pilot-guided-tour",
      screenshotDir,
      domDumpDir,
      prisma
    });

    // Sanity: real row sits alongside the two seeded ones.
    assert.equal(prisma.threads.size, 3);

    await cleanupDemoData(manifest, { screenshotDir, domDumpDir, prisma });

    // The seeded rows are gone; the operator's pre-existing row survives.
    assert.equal(prisma.threads.size, 1);
    assert.ok(prisma.threads.has("real-thread"));
    // People created by the seed are also gone.
    assert.equal(prisma.people.size, 0);
  });
});

test("generic seed mode preserves its 15-row behaviour and still cleans up safely", async () => {
  await withTmpDirs(async ({ screenshotDir, domDumpDir }) => {
    const prisma = createFakePrisma();
    const manifest = await seedDemoData({
      // No mode → generic.
      screenshotDir,
      domDumpDir,
      prisma
    });
    assert.equal(manifest.mode, "generic");
    assert.equal(manifest.threadIds.length, 15);
    assert.equal(manifest.personIds.length, 15);
    assert.equal(manifest.logIds.length, 1);
    // Cleanup wipes exactly what the manifest tracked.
    await cleanupDemoData(manifest, { screenshotDir, domDumpDir, prisma });
    assert.equal(prisma.threads.size, 0);
    assert.equal(prisma.people.size, 0);
    assert.equal(prisma.auditLogs.size, 0);
  });
});
