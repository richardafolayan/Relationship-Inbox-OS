import test from "node:test";
import assert from "node:assert/strict";

// Issue #369. lib/reassess-status tracks in-flight Reassess actions so
// TopStatus can surface "Reassessing thread" in the ticker instead of
// a static pending toast. These tests cover the count semantics and
// idempotency of start/stop, without needing jsdom — we stub a minimal
// global `window` so the module's CustomEvent dispatch works.

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

// Minimal window stub. The module dispatches CustomEvents but the
// behaviour we care about is the in-flight count, exposed via
// _reassessCountForTests.
const listeners = new Set();
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: (_evt, fn) => listeners.add(fn),
  removeEventListener: (_evt, fn) => listeners.delete(fn)
};
globalThis.CustomEvent = FakeCustomEvent;

const { signalReassessStart, _reassessCountForTests } = await import(
  "../apps/dashboard/lib/reassess-status.ts"
);

test("signalReassessStart: increments in-flight count", () => {
  assert.equal(_reassessCountForTests(), 0);
  const stop = signalReassessStart("thread-a");
  assert.equal(_reassessCountForTests(), 1);
  stop();
  assert.equal(_reassessCountForTests(), 0);
});

test("signalReassessStart: same threadId is idempotent (counts as one)", () => {
  const s1 = signalReassessStart("thread-b");
  const s2 = signalReassessStart("thread-b");
  // Two starts for the same thread should not double-count — the
  // ticker doesn't show "Reassessing 2 threads" for one operator
  // double-click.
  assert.equal(_reassessCountForTests(), 1);
  s1();
  // The second stop should be a no-op since the first already cleared
  // the thread from in-flight.
  assert.equal(_reassessCountForTests(), 0);
  s2();
  assert.equal(_reassessCountForTests(), 0);
});

test("signalReassessStart: stop is idempotent (safe to call twice)", () => {
  const stop = signalReassessStart("thread-c");
  assert.equal(_reassessCountForTests(), 1);
  stop();
  stop();
  assert.equal(_reassessCountForTests(), 0);
});

test("signalReassessStart: tracks multiple distinct threads", () => {
  const s1 = signalReassessStart("thread-d");
  const s2 = signalReassessStart("thread-e");
  const s3 = signalReassessStart("thread-f");
  assert.equal(_reassessCountForTests(), 3);
  s2();
  assert.equal(_reassessCountForTests(), 2);
  s1();
  s3();
  assert.equal(_reassessCountForTests(), 0);
});
