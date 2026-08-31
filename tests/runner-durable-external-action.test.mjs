import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  createDurableExternalActionService,
  DurableExternalActionError
} from "../apps/runner/dist/services/durable-external-action.js";

function uniqueError() {
  return new Prisma.PrismaClientKnownRequestError("duplicate action", {
    code: "P2002",
    clientVersion: "test"
  });
}

function harness() {
  const rows = [];
  const threads = [{ id: "thread-1", platform: "LINKEDIN" }];
  let projection = async () => {};
  const prisma = {
    thread: {
      async findUnique({ where }) {
        return threads.find((thread) => thread.id === where.id) ?? null;
      }
    },
    externalActionRequest: {
      async findUnique({ where }) {
        const row = rows.find((candidate) =>
          where.id ? candidate.id === where.id : candidate.clientActionId === where.clientActionId
        );
        return row ? { ...row } : null;
      },
      async create({ data }) {
        if (rows.some((row) => row.clientActionId === data.clientActionId)) throw uniqueError();
        const row = {
          id: `action-${rows.length + 1}`,
          receiptJson: null,
          errorJson: null,
          createdAt: new Date(rows.length + 1),
          ...data
        };
        rows.push(row);
        return { ...row };
      },
      async findFirst({ where }) {
        return rows
          .filter((row) =>
            row.threadId === where.threadId &&
            row.targetMessageId === where.targetMessageId &&
            row.actionType === where.actionType &&
            row.status === where.status
          )
          .sort((left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)
          )[0] ?? null;
      },
      async updateMany({ where, data }) {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row || row.status !== where.status || row.receiptJson !== where.receiptJson) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      async update({ where, data }) {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("missing action row");
        Object.assign(row, data);
        return { ...row };
      },
      async findMany() {
        return rows
          .filter((row) => row.status === "SENT" && row.errorJson?.includes("local_projection_required"))
          .map((row) => ({ ...row }));
      }
    }
  };
  return {
    rows,
    setProjection(next) { projection = next; },
    service: createDurableExternalActionService({
      prisma,
      project: (row) => projection(row),
      withExternalActionLock: (_platform, work) => work(),
      withPlatformLock: (_platform, work) => work()
    })
  };
}

function input(overrides = {}) {
  return {
    clientActionId: "11111111-1111-4111-8111-111111111111",
    threadId: "thread-1",
    targetMessageId: "message-1",
    actionType: "message_edit",
    payload: { text: "Corrected" },
    dispatch: async () => {},
    auditSuccess: async () => {},
    auditFailure: async () => {},
    ...overrides
  };
}

test("replaying one completed external action never dispatches twice", async () => {
  const h = harness();
  let dispatches = 0;
  const action = input({ dispatch: async () => { dispatches += 1; } });

  assert.deepEqual(await h.service.execute(action), { status: "ok", replayed: false });
  assert.deepEqual(await h.service.execute(action), { status: "ok", replayed: true });
  assert.equal(dispatches, 1);
  assert.equal(h.rows[0].status, "SENT");
});

test("post-dispatch projection failure is durable, replay repairs locally without redispatch", async () => {
  const h = harness();
  let dispatches = 0;
  let projectionFails = true;
  h.setProjection(async () => {
    if (projectionFails) throw new Error("database unavailable");
  });
  const action = input({ dispatch: async () => { dispatches += 1; } });

  await h.service.execute(action);
  assert.deepEqual(await h.service.execute(action), {
    status: "ok",
    replayed: true,
    reconciliationPending: true
  });
  assert.equal(JSON.parse(h.rows[0].errorJson).reconciliationRequired, true);
  projectionFails = false;
  assert.deepEqual(await h.service.execute(action), { status: "ok", replayed: true });
  assert.equal(dispatches, 1);
  assert.equal(h.rows[0].errorJson, null);
});

test("startup reconciliation repairs a completed action without redispatch", async () => {
  const h = harness();
  let projectionFails = true;
  let projections = 0;
  h.setProjection(async () => {
    projections += 1;
    if (projectionFails) throw new Error("database unavailable");
  });
  await h.service.execute(input());
  projectionFails = false;
  assert.equal(await h.service.reconcileSentProjections(), 1);
  assert.equal(projections, 2);
  assert.equal(h.rows[0].errorJson, null);
});

test("a reused client action id cannot be linked to different intent", async () => {
  const h = harness();
  await h.service.execute(input());
  await assert.rejects(
    () => h.service.execute(input({ payload: { text: "Different" } })),
    (error) => error instanceof DurableExternalActionError && error.reason === "action_conflict"
  );
});

test("repairing an older edit cannot overwrite a newer completed edit", async () => {
  const h = harness();
  const projected = [];
  let failFirst = true;
  h.setProjection(async (row) => {
    const text = JSON.parse(row.payloadJson).text;
    if (text === "Older" && failFirst) throw new Error("database unavailable");
    projected.push(text);
  });
  const older = input({
    clientActionId: "11111111-1111-4111-8111-111111111111",
    payload: { text: "Older" }
  });
  const newer = input({
    clientActionId: "22222222-2222-4222-8222-222222222222",
    payload: { text: "Newer" }
  });
  await h.service.execute(older);
  await h.service.execute(newer);
  failFirst = false;
  await h.service.execute(older);
  assert.deepEqual(projected, ["Newer"]);
  assert.equal(h.rows[0].errorJson, null);
});

test("an ambiguous dispatch failure is never retried", async () => {
  const h = harness();
  let dispatches = 0;
  const action = input({
    dispatch: async () => {
      dispatches += 1;
      throw new Error("save detection timed out after click");
    }
  });

  await assert.rejects(() => h.service.execute(action), (error) => {
    assert.equal(error instanceof DurableExternalActionError, true);
    assert.equal(error.reason, "delivery_uncertain");
    return true;
  });
  await assert.rejects(() => h.service.execute(action), /may already have reached/i);
  assert.equal(dispatches, 1);
});

test("a proven pre-dispatch failure releases the durable claim for a safe retry", async () => {
  const h = harness();
  let connected = false;
  let dispatches = 0;
  const sessionUnavailable = new Error("session unavailable before dispatch");
  const action = input({
    isPreDispatchFailure: (error) => error === sessionUnavailable,
    dispatch: async () => {
      if (!connected) throw sessionUnavailable;
      dispatches += 1;
    }
  });

  await assert.rejects(() => h.service.execute(action), (error) => error === sessionUnavailable);
  assert.equal(h.rows[0].status, "PENDING");
  assert.equal(h.rows[0].receiptJson, null);

  connected = true;
  assert.deepEqual(await h.service.execute(action), { status: "ok", replayed: false });
  assert.equal(dispatches, 1);
});

test("selection revocation before reaction, edit, or vote dispatch releases the claim", async () => {
  for (const actionType of ["message_reaction", "message_edit", "poll_vote"]) {
    const h = harness();
    let dispatches = 0;
    const revoked = new Error("platform not selected");
    const action = input({
      clientActionId: `${actionType}-1111-4111-8111-111111111111`,
      actionType,
      beforeDispatch: async () => { throw revoked; },
      dispatch: async () => { dispatches += 1; }
    });

    await assert.rejects(() => h.service.execute(action), (error) => error === revoked);
    assert.equal(dispatches, 0);
    assert.equal(h.rows[0].status, "PENDING");
    assert.equal(h.rows[0].receiptJson, null);
  }
});

test("concurrent identical actions have one claim winner and one physical dispatch", async () => {
  const h = harness();
  let dispatches = 0;
  let releaseDispatch;
  let markDispatchStarted;
  const dispatchStarted = new Promise((resolve) => { markDispatchStarted = resolve; });
  const action = input({
    dispatch: async () => {
      dispatches += 1;
      markDispatchStarted();
      await new Promise((resolve) => { releaseDispatch = resolve; });
    }
  });

  const first = h.service.execute(action);
  await dispatchStarted;
  await assert.rejects(() => h.service.execute(action), /already in progress|may already have reached/i);
  releaseDispatch();
  await first;
  assert.equal(dispatches, 1);
});
