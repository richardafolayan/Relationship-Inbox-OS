import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReassessOnSendHandler } from "../apps/runner/dist/services/reassess-on-send.js";
import { createEventBus } from "../apps/runner/dist/services/event-bus.js";

// Richard: "every time I receive a new message or I send one, the AI should
// reassess the chat, so I can see what I've replied to and what still needs a
// reply." Inbound is already reassessed inline by scans. This module closes the
// send-side gap: a dashboard send emits MESSAGE_SENT but nothing recomputed the
// brief, so the rail stayed stale until the next scan. createReassessOnSendHandler
// reassesses immediately on MESSAGE_SENT, deduped per thread, non-blocking.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("MESSAGE_SENT triggers a reassess for the thread and fires onReassessed on success", async () => {
  const calls = [];
  const reassessed = [];
  const handler = createReassessOnSendHandler({
    resummarize: async (id) => {
      calls.push(id);
      return { ok: true };
    },
    onReassessed: (id) => reassessed.push(id)
  });

  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  const inFlight = handler.inFlight.get("t1");
  assert.ok(inFlight, "reassess should be in flight immediately after the event");
  await inFlight;

  assert.deepEqual(calls, ["t1"]);
  assert.deepEqual(reassessed, ["t1"]);
  assert.equal(handler.inFlight.has("t1"), false, "in-flight slot clears after completion");
});

test("ignores events that are not MESSAGE_SENT", async () => {
  const calls = [];
  const handler = createReassessOnSendHandler({
    resummarize: async (id) => {
      calls.push(id);
      return { ok: true };
    }
  });
  handler.handle({ type: "THREAD_UPDATED", threadId: "t1" });
  handler.handle({ type: "MESSAGE_SEND_FAILED", threadId: "t1" });
  handler.handle({ type: "SCAN_THREAD_FINISHED", threadId: "t1" });
  assert.deepEqual(calls, []);
});

test("ignores a MESSAGE_SENT with no threadId", async () => {
  const calls = [];
  const handler = createReassessOnSendHandler({
    resummarize: async (id) => {
      calls.push(id);
      return { ok: true };
    }
  });
  handler.handle({ type: "MESSAGE_SENT" });
  assert.deepEqual(calls, []);
});

test("dedupes a burst of sends to the same thread, then reassesses again after it completes", async () => {
  const pending = [];
  const reassessed = [];
  const handler = createReassessOnSendHandler({
    resummarize: () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    onReassessed: (id) => reassessed.push(id)
  });

  // Three sends to t1 while the first reassess is mid-flight -> coalesced to one.
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  assert.equal(pending.length, 1, "only one reassess runs while the first is in flight");

  const first = handler.inFlight.get("t1");
  pending[0].resolve({ ok: true });
  await first;
  assert.deepEqual(reassessed, ["t1"], "onReassessed fires once for the coalesced burst");
  assert.equal(handler.inFlight.has("t1"), false);

  // A later send (after completion) reassesses again — the slot was freed.
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  assert.equal(pending.length, 2, "a send after completion reassesses again");
  pending[1].resolve({ ok: true });
  await handler.inFlight.get("t1");
  assert.deepEqual(reassessed, ["t1", "t1"]);
});

test("two different threads reassess independently (not deduped against each other)", async () => {
  const calls = [];
  const handler = createReassessOnSendHandler({
    resummarize: async (id) => {
      calls.push(id);
      return { ok: true };
    }
  });
  handler.handle({ type: "MESSAGE_SENT", threadId: "a" });
  handler.handle({ type: "MESSAGE_SENT", threadId: "b" });
  await Promise.all([handler.inFlight.get("a"), handler.inFlight.get("b")].filter(Boolean));
  assert.deepEqual(calls.sort(), ["a", "b"]);
});

test("a not-found / unsuccessful reassess does NOT fire onReassessed, and clears the slot", async () => {
  const reassessed = [];
  const handler = createReassessOnSendHandler({
    resummarize: async () => ({ ok: false }),
    onReassessed: (id) => reassessed.push(id)
  });
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  await handler.inFlight.get("t1");
  assert.deepEqual(reassessed, [], "no THREAD_UPDATED on an unsuccessful reassess");
  assert.equal(handler.inFlight.has("t1"), false);
});

test("a rejecting reassess is caught (non-blocking), routed to onError, and clears the slot", async () => {
  const errors = [];
  const reassessed = [];
  const handler = createReassessOnSendHandler({
    resummarize: async () => {
      throw new Error("provider exploded");
    },
    onReassessed: (id) => reassessed.push(id),
    onError: (id, err) => errors.push([id, err instanceof Error ? err.message : String(err)])
  });
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  await handler.inFlight.get("t1");
  assert.deepEqual(reassessed, []);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], ["t1", "provider exploded"]);
  assert.equal(handler.inFlight.has("t1"), false);
});

test("a hung reassess hits the timeout, routes to onError, and frees the slot", async () => {
  const errors = [];
  const handler = createReassessOnSendHandler({
    resummarize: () => new Promise(() => {}), // never resolves
    onError: (id, err) => errors.push([id, err instanceof Error ? err.message : String(err)]),
    timeoutMs: 20
  });
  handler.handle({ type: "MESSAGE_SENT", threadId: "t1" });
  await handler.inFlight.get("t1");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "t1");
  assert.match(errors[0][1], /exceeded 20ms/);
  assert.equal(handler.inFlight.has("t1"), false);
});

test("integration: emitting MESSAGE_SENT on the real event bus reassesses and emits THREAD_UPDATED", async () => {
  // Wires the handler to the REAL event bus exactly as index.ts does, so this
  // proves subscribe + emit + handle + the THREAD_UPDATED feedback work
  // together — not just that handle() can be called directly. A real send is
  // never triggered here (that would message a live contact); we emit the
  // MESSAGE_SENT the send path would emit.
  const bus = createEventBus();
  const resummarized = [];
  const handler = createReassessOnSendHandler({
    resummarize: async (id) => {
      resummarized.push(id);
      return { ok: true };
    },
    onReassessed: (id) => bus.emit({ type: "THREAD_UPDATED", jobId: "job-test", threadId: id })
  });
  bus.subscribe((event) => handler.handle(event));

  const threadUpdated = [];
  bus.subscribe((event) => {
    if (event.type === "THREAD_UPDATED") threadUpdated.push(event.threadId);
  });

  bus.emit({ type: "MESSAGE_SENT", jobId: "job-1", threadId: "t1", platform: "IMESSAGE" });
  await handler.inFlight.get("t1");

  assert.deepEqual(resummarized, ["t1"], "MESSAGE_SENT on the bus reassesses the thread");
  assert.deepEqual(threadUpdated, ["t1"], "a successful reassess emits THREAD_UPDATED back onto the bus");

  // A MESSAGE_SEND_FAILED on the bus must NOT reassess.
  bus.emit({ type: "MESSAGE_SEND_FAILED", jobId: "job-2", threadId: "t2", platform: "IMESSAGE", logId: "l1" });
  assert.equal(handler.inFlight.has("t2"), false);
  assert.deepEqual(resummarized, ["t1"]);
});

test("the handler is wired into the runner: MESSAGE_SENT -> resummarize -> THREAD_UPDATED", () => {
  const indexJsPath = fileURLToPath(new URL("../apps/runner/dist/index.js", import.meta.url));
  const source = readFileSync(indexJsPath, "utf8");
  // The module is imported and the handler constructed.
  assert.ok(source.includes("createReassessOnSendHandler("), "handler must be constructed in index");
  // It reassesses via the same per-thread pipeline the manual Reassess uses.
  assert.ok(source.includes("resummarizeThreadById(threadId)"), "must reassess via resummarizeThreadById");
  // On success it emits THREAD_UPDATED so the dashboard refetches the rail.
  assert.ok(/THREAD_UPDATED[\s\S]{0,80}threadId/.test(source), "must emit THREAD_UPDATED on reassess");
  // And it is actually subscribed to the event bus.
  assert.ok(/eventBus\.subscribe\([\s\S]{0,60}reassessOnSend\.handle/.test(source), "handler must be subscribed to the event bus");
});
