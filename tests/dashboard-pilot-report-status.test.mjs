import test from "node:test";
import assert from "node:assert/strict";

// Issue #421 / pilot R-0047. lib/pilot-report-status tracks in-flight
// pilot-feedback report submissions so TopStatus can surface "Sending
// report" in the ticker after the modal closes. These tests mirror
// dashboard-reassess-status — minimal window stub, no jsdom — and
// cover the count semantics and idempotency of start/stop.

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

const listeners = new Set();
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: (_evt, fn) => listeners.add(fn),
  removeEventListener: (_evt, fn) => listeners.delete(fn)
};
globalThis.CustomEvent = FakeCustomEvent;

const { signalReportSendStart, _reportSendCountForTests } = await import(
  "../apps/dashboard/lib/pilot-report-status.ts"
);

test("signalReportSendStart: increments and decrements the in-flight count", () => {
  const before = _reportSendCountForTests();
  const stop = signalReportSendStart();
  assert.equal(_reportSendCountForTests(), before + 1);
  stop();
  assert.equal(_reportSendCountForTests(), before);
});

test("signalReportSendStart: concurrent submits do not collapse", () => {
  const before = _reportSendCountForTests();
  const s1 = signalReportSendStart();
  const s2 = signalReportSendStart();
  // Unlike reassess (which keyed on threadId), pilot reports are
  // anonymous submits — two parallel sends must both show in the
  // ticker so the operator knows two are uploading.
  assert.equal(_reportSendCountForTests(), before + 2);
  s1();
  assert.equal(_reportSendCountForTests(), before + 1);
  s2();
  assert.equal(_reportSendCountForTests(), before);
});

test("signalReportSendStart: stop is idempotent", () => {
  const before = _reportSendCountForTests();
  const stop = signalReportSendStart();
  stop();
  stop();
  // Double-stop should not push the count below where it started —
  // a stray .finally() chained twice shouldn't underflow the set.
  assert.equal(_reportSendCountForTests(), before);
});
