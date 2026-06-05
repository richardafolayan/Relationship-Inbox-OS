import test from "node:test";
import assert from "node:assert/strict";

// Dashboard helpers ship as TypeScript; the runner is `node --import tsx`
// from the root package.json so the .ts import below resolves at runtime.
const { isDemoThread, scopeRowsToSandbox } = await import(
  "../apps/dashboard/lib/demo-threads.ts"
);

const realRow = (id) => ({ id, platformThreadId: `real-${id}`, personName: id });
const demoRow = (slug) => ({ id: slug, platformThreadId: `demo-full-${slug}`, personName: slug });

test("isDemoThread: only demo- prefixed platformThreadIds count as demo", () => {
  assert.equal(isDemoThread({ platformThreadId: "demo-full-serena-imessage" }), true);
  assert.equal(isDemoThread({ platformThreadId: "demo-LINKEDIN-0" }), true);
  assert.equal(isDemoThread({ platformThreadId: "li-12345" }), false);
  assert.equal(isDemoThread({ platformThreadId: null }), false);
  assert.equal(isDemoThread({}), false);
});

test("scopeRowsToSandbox: in a sandbox flow, a busy real inbox is narrowed to demo-only", () => {
  // Repro shape: 200 real overdue threads with the demo Serena/Timi seeded in.
  // Before the fix, Serena was buried below the real threads and never reached
  // Today's capped queue, so the tour's `thread-row-...serena` target fell back
  // to `today-hero` (a real thread).
  const rows = [
    ...Array.from({ length: 200 }, (_, i) => realRow(`overdue-${i}`)),
    demoRow("serena-imessage"),
    demoRow("timi-linkedin")
  ];

  const scoped = scopeRowsToSandbox(rows, true);
  assert.equal(scoped.length, 2, "only the two demo threads survive in a sandbox flow");
  assert.ok(
    scoped.some((r) => r.platformThreadId === "demo-full-serena-imessage"),
    "demo Serena survives so her row renders and the tour target resolves"
  );
  assert.ok(
    !scoped.some((r) => String(r.platformThreadId).startsWith("real-")),
    "no real threads leak into the sandbox view"
  );
});

test("scopeRowsToSandbox: outside a sandbox flow, real threads are untouched", () => {
  const rows = [realRow("a"), realRow("b"), demoRow("serena-imessage")];
  const normal = scopeRowsToSandbox(rows, false);
  assert.equal(normal, rows, "no copy / no filtering in normal app mode");
  assert.ok(normal.some((r) => r.platformThreadId === "real-a"));
});
