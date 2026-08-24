import test from "node:test";
import assert from "node:assert/strict";
import { createScheduledSendPromoter } from "../apps/runner/dist/services/scheduled-send-promoter.js";

// In-memory fake of the slice of Prisma the promoter touches. Mirrors the
// `ScheduledSendPromoterPrisma` interface so changes there break the tests.
function createFakePrisma(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  return {
    rows,
    sendRequest: {
      async findMany({ where }) {
        const byTime = where.scheduledFor.lte.getTime();
        return rows
          .filter((r) => r.status === "SCHEDULED" && r.scheduledFor.getTime() <= byTime)
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
          .map((r) => ({
            id: r.id,
            clientSendId: r.clientSendId,
            thread: { platform: r.platform ?? "LINKEDIN" }
          }));
      },
      async updateMany({ where, data }) {
        const ids = new Set(where.id.in);
        let count = 0;
        for (const r of rows) {
          if (ids.has(r.id)) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
      async count({ where }) {
        return rows.filter((r) => r.status === where.status).length;
      }
    }
  };
}

function createCountingSendQueue() {
  let kicks = 0;
  return {
    kicks: () => kicks,
    enqueueAndKick: async () => {
      throw new Error("not used");
    },
    kick: () => {
      kicks += 1;
    },
    resume: () => {},
    getActiveCount: async () => 0
  };
}

function createCountingEventBus() {
  const events = [];
  return {
    events,
    nextEventId: () => events.length + 1,
    emit: (event) => {
      const enriched = { ...event, eventId: events.length + 1, at: new Date().toISOString() };
      events.push(enriched);
      return enriched;
    },
    subscribe: () => () => {},
    listSince: () => [],
    newestEventId: () => events.length,
    oldestEventId: () => 1
  };
}

test("promoter flips SCHEDULED rows whose time has passed to PENDING and kicks the send queue", async () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 5 * 60_000);
  const fake = createFakePrisma([
    { id: "due-a", clientSendId: "cs-a", status: "SCHEDULED", scheduledFor: past },
    { id: "due-b", clientSendId: "cs-b", status: "SCHEDULED", scheduledFor: past },
    { id: "early", clientSendId: "cs-c", status: "SCHEDULED", scheduledFor: future }
  ]);
  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();

  const promoter = createScheduledSendPromoter({
    sendQueue,
    eventBus,
    prisma: fake
  });

  const { promoted } = await promoter.tick();

  assert.equal(promoted, 2, "two rows whose scheduledFor has passed should promote");
  assert.equal(fake.rows.find((r) => r.id === "due-a").status, "PENDING");
  assert.equal(fake.rows.find((r) => r.id === "due-b").status, "PENDING");
  assert.equal(
    fake.rows.find((r) => r.id === "early").status,
    "SCHEDULED",
    "rows scheduled for the future must remain SCHEDULED"
  );
  assert.equal(sendQueue.kicks(), 1, "should kick the send queue exactly once when promotions happen");
  assert.equal(eventBus.events.length, 1);
  assert.equal(eventBus.events[0].type, "SEND_QUEUE_UPDATED");
  assert.equal(eventBus.events[0].activeCount, 2, "active count should reflect newly-PENDING rows");
});

test("promoter terminalises due Instagram schedules without kicking them into the send queue", async () => {
  const past = new Date(Date.now() - 60_000);
  const fake = createFakePrisma([
    {
      id: "instagram-due",
      clientSendId: "cs-instagram",
      status: "SCHEDULED",
      scheduledFor: past,
      platform: "INSTAGRAM"
    }
  ]);
  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();
  const promoter = createScheduledSendPromoter({ sendQueue, eventBus, prisma: fake });

  const { promoted } = await promoter.tick();

  assert.equal(promoted, 0);
  assert.equal(fake.rows[0].status, "FAILED");
  assert.match(fake.rows[0].errorJson, /user-triggered sends only/);
  assert.equal(sendQueue.kicks(), 0);
  assert.equal(eventBus.events.length, 0);
});

test("promoter only promotes non-Instagram rows from a mixed due batch", async () => {
  const past = new Date(Date.now() - 60_000);
  const fake = createFakePrisma([
    {
      id: "instagram-due",
      clientSendId: "cs-instagram",
      status: "SCHEDULED",
      scheduledFor: past,
      platform: "INSTAGRAM"
    },
    {
      id: "linkedin-due",
      clientSendId: "cs-linkedin",
      status: "SCHEDULED",
      scheduledFor: past,
      platform: "LINKEDIN"
    }
  ]);
  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();
  const promoter = createScheduledSendPromoter({ sendQueue, eventBus, prisma: fake });

  const { promoted } = await promoter.tick();

  assert.equal(promoted, 1);
  assert.equal(fake.rows.find((row) => row.id === "instagram-due").status, "FAILED");
  assert.equal(fake.rows.find((row) => row.id === "linkedin-due").status, "PENDING");
  assert.equal(sendQueue.kicks(), 1);
  assert.equal(eventBus.events[0].activeCount, 1);
});

test("promoter no-ops and does not kick the queue when nothing is due", async () => {
  const future = new Date(Date.now() + 5 * 60_000);
  const fake = createFakePrisma([
    { id: "early", clientSendId: "cs-c", status: "SCHEDULED", scheduledFor: future }
  ]);
  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();

  const promoter = createScheduledSendPromoter({
    sendQueue,
    eventBus,
    prisma: fake
  });

  const { promoted } = await promoter.tick();

  assert.equal(promoted, 0);
  assert.equal(sendQueue.kicks(), 0, "no kick when there's nothing to drain");
  assert.equal(eventBus.events.length, 0, "no SEND_QUEUE_UPDATED event when nothing changed");
  assert.equal(fake.rows[0].status, "SCHEDULED");
});

test("promoter ignores rows in non-SCHEDULED statuses even if their scheduledFor has passed", async () => {
  // Defends against a concurrent cancel + tick race: if a row was flipped
  // to CANCELLED between insert and tick, the promoter must not resurrect
  // it. The findMany filter keys on status, so this is really verifying
  // that the where clause stays correct.
  const past = new Date(Date.now() - 60_000);
  const fake = createFakePrisma([
    { id: "cancelled", clientSendId: "cs-x", status: "CANCELLED", scheduledFor: past },
    { id: "sent", clientSendId: "cs-y", status: "SENT", scheduledFor: past }
  ]);
  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();

  const promoter = createScheduledSendPromoter({
    sendQueue,
    eventBus,
    prisma: fake
  });

  const { promoted } = await promoter.tick();

  assert.equal(promoted, 0);
  assert.equal(fake.rows.find((r) => r.id === "cancelled").status, "CANCELLED");
  assert.equal(fake.rows.find((r) => r.id === "sent").status, "SENT");
  assert.equal(sendQueue.kicks(), 0);
});

test("promoter tick is reentrancy-safe: a second concurrent call sees promoted=0", async () => {
  const past = new Date(Date.now() - 60_000);
  const fake = createFakePrisma([
    { id: "due-a", clientSendId: "cs-a", status: "SCHEDULED", scheduledFor: past }
  ]);
  // Block the first findMany so we can race a second tick into it.
  let releaseFindMany;
  const blocker = new Promise((resolve) => {
    releaseFindMany = resolve;
  });
  const originalFindMany = fake.sendRequest.findMany.bind(fake.sendRequest);
  let firstCall = true;
  fake.sendRequest.findMany = async (args) => {
    if (firstCall) {
      firstCall = false;
      await blocker;
    }
    return originalFindMany(args);
  };

  const sendQueue = createCountingSendQueue();
  const eventBus = createCountingEventBus();
  const promoter = createScheduledSendPromoter({
    sendQueue,
    eventBus,
    prisma: fake
  });

  const firstTick = promoter.tick();
  // Second tick fires while first is mid-await. The reentry guard should
  // make it return immediately with promoted=0 instead of double-promoting.
  const secondTickResult = await promoter.tick();
  releaseFindMany();
  const firstTickResult = await firstTick;

  assert.equal(secondTickResult.promoted, 0, "concurrent tick should return without doing work");
  assert.equal(firstTickResult.promoted, 1, "original tick still completes its work");
  assert.equal(sendQueue.kicks(), 1, "send queue is only kicked by the original tick");
});
