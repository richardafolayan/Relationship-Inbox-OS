import test from "node:test";
import assert from "node:assert/strict";

// Pure service. No Prisma, no Express. Imports the .ts sources through
// the tsx loader (the same pattern dashboard-horizon.test.mjs uses) rather
// than the runner's compiled dist, because the worktree's shared
// node_modules symlinks @inbox-os/core to the parent project — building
// the worktree's core dist doesn't update what the dist's `import
// "@inbox-os/core"` resolves to.
const {
  applyAck,
  applyDismissToday,
  applySnoozePerson,
  applyUnsnoozePerson,
  computeTick,
  listSnoozedPeople,
  selectCandidates
} = await import("../apps/runner/src/services/overdue-digest.ts");

const { DEFAULT_OVERDUE_DIGEST_SETTINGS, isDigestDue, buildStateKey } = await import(
  "../packages/core/src/overdue-digest.ts"
);
const { isNonActionableInboundPlaceholder } = await import(
  "../packages/core/src/deleted-placeholder.ts"
);

const NOW = "2026-05-26T12:00:00.000Z";
const TODAY_LOCAL_DATE = "2026-05-26";

function row(overrides = {}) {
  return {
    threadId: "t-1",
    personId: "p-1",
    personName: "Brandon",
    riskLevel: "RED",
    needsReply: true,
    lastInboundAt: "2026-05-24T09:00:00.000Z",
    lastMessageAt: "2026-05-24T09:00:00.000Z",
    lastMessageDirection: "IN",
    preview: "Are you around this week?",
    whatTheyWant: "Wants to grab a coffee",
    archivedAt: null,
    snoozedUntil: null,
    scheduledSendAt: null,
    closedStatus: null,
    ...overrides
  };
}

function defaults() {
  return JSON.parse(JSON.stringify(DEFAULT_OVERDUE_DIGEST_SETTINGS));
}

test("default settings are cadence=off, no memory", () => {
  assert.deepEqual(defaults(), {
    cadence: "off",
    lastDigestAt: null,
    dismissForLocalDate: null,
    perPerson: {}
  });
});

test("isDigestDue: off never due", () => {
  assert.equal(isDigestDue("off", null, NOW, TODAY_LOCAL_DATE), false);
  assert.equal(isDigestDue("off", "2026-05-26T00:00:00.000Z", NOW, TODAY_LOCAL_DATE), false);
});

test("isDigestDue: daily — never, yesterday, today", () => {
  assert.equal(isDigestDue("daily", null, NOW, TODAY_LOCAL_DATE), true);
  assert.equal(
    isDigestDue("daily", "2026-05-25T08:00:00.000Z", NOW, TODAY_LOCAL_DATE),
    true,
    "yesterday's digest still allows today"
  );
  assert.equal(
    isDigestDue("daily", "2026-05-26T00:30:00.000Z", NOW, TODAY_LOCAL_DATE),
    false,
    "already fired earlier today"
  );
});

test("isDigestDue: weekly uses a 7-day rolling window", () => {
  assert.equal(isDigestDue("weekly", null, NOW, TODAY_LOCAL_DATE), true);
  assert.equal(
    isDigestDue("weekly", "2026-05-22T12:00:00.000Z", NOW, TODAY_LOCAL_DATE),
    false,
    "4 days ago is too soon"
  );
  assert.equal(
    isDigestDue("weekly", "2026-05-19T12:00:00.000Z", NOW, TODAY_LOCAL_DATE),
    true,
    "exactly 7 days ago re-arms"
  );
  assert.equal(
    isDigestDue("weekly", "2026-05-18T12:00:00.000Z", NOW, TODAY_LOCAL_DATE),
    true,
    "8 days ago is overdue"
  );
});

test("selectCandidates: keeps RED+AMBER needs-reply, drops GREEN / replied / archived / closed / scheduled", () => {
  const settings = defaults();
  const rows = [
    row({ threadId: "t-red", personId: "p-red", personName: "Red", riskLevel: "RED" }),
    row({ threadId: "t-amber", personId: "p-amber", personName: "Amber", riskLevel: "AMBER" }),
    row({ threadId: "t-green", personId: "p-green", riskLevel: "GREEN" }),
    row({ threadId: "t-replied", personId: "p-replied", needsReply: false }),
    row({ threadId: "t-arc", personId: "p-arc", archivedAt: "2026-05-20T00:00:00.000Z" }),
    row({ threadId: "t-closed", personId: "p-closed", closedStatus: "closed" }),
    row({
      threadId: "t-sched",
      personId: "p-sched",
      scheduledSendAt: "2026-05-27T10:00:00.000Z"
    }),
    row({
      threadId: "t-thread-snoozed",
      personId: "p-thread-snoozed",
      snoozedUntil: "2026-06-01T00:00:00.000Z"
    })
  ];
  const out = selectCandidates({ rows, settings, nowIso: NOW });
  assert.deepEqual(
    out.map((c) => c.personId),
    ["p-red", "p-amber"]
  );
});

test("selectCandidates: skips rows where BOTH preview and whatTheyWant are placeholders", () => {
  // Post-#364, scan-queue already keeps deleted placeholders out of
  // `lastInboundAt` and needs-reply state. A row reaching the digest
  // with a placeholder preview but a real `whatTheyWant` means the AI
  // saw a genuine earlier inbound the operator still owes a reply to —
  // those rows are KEPT. Rows where both signals collapse to placeholder
  // text get skipped as a last-resort guard.
  const settings = defaults();
  const rows = [
    row({
      threadId: "t-deleted-both",
      personId: "p-deleted-both",
      preview: "This message has been deleted",
      whatTheyWant: "This message has been deleted"
    }),
    row({
      threadId: "t-deleted-with-ai",
      personId: "p-deleted-with-ai",
      personName: "Deleted-but-AI-has-context",
      preview: "This message was deleted",
      whatTheyWant: "Wants to grab a coffee"
    }),
    row({ threadId: "t-keep", personId: "p-keep", personName: "Keep" })
  ];
  const out = selectCandidates({ rows, settings, nowIso: NOW });
  assert.deepEqual(
    out.map((c) => c.personId),
    ["p-deleted-with-ai", "p-keep"]
  );
});

test("isNonActionableInboundPlaceholder catches the documented platform phrasings", () => {
  assert.equal(isNonActionableInboundPlaceholder("This message has been deleted"), true);
  assert.equal(isNonActionableInboundPlaceholder("This message was deleted"), true);
  assert.equal(isNonActionableInboundPlaceholder("Message unsent"), true);
  assert.equal(isNonActionableInboundPlaceholder("Looking forward to chatting"), false);
  assert.equal(isNonActionableInboundPlaceholder(""), false);
  assert.equal(isNonActionableInboundPlaceholder(null), false);
});

test("selectCandidates: drops rows outside the 30-day horizon", () => {
  const settings = defaults();
  const rows = [
    row({
      threadId: "t-fresh",
      personId: "p-fresh",
      lastMessageAt: "2026-05-20T00:00:00.000Z"
    }),
    row({
      threadId: "t-old",
      personId: "p-old",
      lastMessageAt: "2026-03-01T00:00:00.000Z",
      lastInboundAt: "2026-03-01T00:00:00.000Z"
    })
  ];
  const out = selectCandidates({ rows, settings, nowIso: NOW });
  assert.deepEqual(
    out.map((c) => c.personId),
    ["p-fresh"]
  );
});

test("selectCandidates: person-snooze excludes; unsnooze restores eligibility", () => {
  const candidate = row({ personId: "p-snz", personName: "Snoozey" });
  const snoozed = applySnoozePerson(
    defaults(),
    "p-snz",
    "Snoozey",
    "2026-06-15T00:00:00.000Z"
  );
  assert.equal(selectCandidates({ rows: [candidate], settings: snoozed, nowIso: NOW }).length, 0);

  const unsnoozed = applyUnsnoozePerson(snoozed, "p-snz");
  const out = selectCandidates({ rows: [candidate], settings: unsnoozed, nowIso: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].personId, "p-snz");
});

test("selectCandidates: dedupes against the immediately-previous sent digest with same state", () => {
  const r = row({ personId: "p-x", personName: "X" });
  // Pretend a digest just fired and included p-x with the row's current state key.
  const stateKey = buildStateKey(r);
  const acked = applyAck(defaults(), [{ personId: "p-x", displayName: "X", stateKey }], NOW);
  // Same person, same state, immediately afterwards — must be skipped.
  const out = selectCandidates({ rows: [r], settings: acked, nowIso: NOW });
  assert.equal(out.length, 0);

  // State changes (e.g. a new inbound minute) — eligible again.
  const moved = row({
    personId: "p-x",
    personName: "X",
    lastInboundAt: "2026-05-25T11:30:00.000Z"
  });
  const out2 = selectCandidates({ rows: [moved], settings: acked, nowIso: NOW });
  assert.equal(out2.length, 1);
});

test("selectCandidates: a skipped person becomes eligible again after a different digest fires", () => {
  const px = row({ personId: "p-x", personName: "X" });
  const stateKeyX = buildStateKey(px);
  // Digest 1 includes p-x.
  const afterFirst = applyAck(
    defaults(),
    [{ personId: "p-x", displayName: "X", stateKey: stateKeyX }],
    "2026-05-24T10:00:00.000Z"
  );

  // Digest 2 (today) includes someone else, NOT p-x. p-x's lastIncludedAt
  // is still the earlier timestamp, so on this tick p-x is dedupe-skipped.
  // After ack, lastDigestAt moves to NOW and p-x's lastIncludedAt no longer
  // matches lastDigestAt — so on the next tick (digest 3) p-x is eligible.
  const py = row({ personId: "p-y", personName: "Y" });
  const stateKeyY = buildStateKey(py);
  const afterSecond = applyAck(
    afterFirst,
    [{ personId: "p-y", displayName: "Y", stateKey: stateKeyY }],
    NOW
  );

  const out = selectCandidates({ rows: [px], settings: afterSecond, nowIso: NOW });
  assert.equal(out.length, 1, "p-x re-eligible because they weren't in the most recent digest");
});

test("computeTick: cadence off returns due=false reason=cadence_off", () => {
  const result = computeTick({
    settings: defaults(),
    rows: [row()],
    nowIso: NOW,
    localDate: TODAY_LOCAL_DATE
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "cadence_off");
  assert.deepEqual(result.candidates, []);
});

test("computeTick: dismissForLocalDate suppresses today", () => {
  let s = defaults();
  s.cadence = "daily";
  s = applyDismissToday(s, TODAY_LOCAL_DATE);
  const result = computeTick({
    settings: s,
    rows: [row()],
    nowIso: NOW,
    localDate: TODAY_LOCAL_DATE
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "dismissed_today");
});

test("computeTick: dismiss expires when local date rolls over", () => {
  let s = defaults();
  s.cadence = "daily";
  s = applyDismissToday(s, "2026-05-25");
  const result = computeTick({
    settings: s,
    rows: [row()],
    nowIso: NOW,
    localDate: TODAY_LOCAL_DATE
  });
  assert.equal(result.due, true);
  assert.equal(result.candidates.length, 1);
});

test("computeTick: no candidates reports not due", () => {
  const s = { ...defaults(), cadence: "daily" };
  const result = computeTick({
    settings: s,
    rows: [row({ riskLevel: "GREEN" })],
    nowIso: NOW,
    localDate: TODAY_LOCAL_DATE
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "no_candidates");
});

test("computeTick: RED sorts before AMBER, oldest waiting first within a level", () => {
  const s = { ...defaults(), cadence: "daily" };
  const rows = [
    row({
      threadId: "t-amber-old",
      personId: "p-amber-old",
      personName: "Amber-old",
      riskLevel: "AMBER",
      lastInboundAt: "2026-05-21T08:00:00.000Z"
    }),
    row({
      threadId: "t-red-new",
      personId: "p-red-new",
      personName: "Red-new",
      riskLevel: "RED",
      lastInboundAt: "2026-05-25T08:00:00.000Z"
    }),
    row({
      threadId: "t-red-old",
      personId: "p-red-old",
      personName: "Red-old",
      riskLevel: "RED",
      lastInboundAt: "2026-05-20T08:00:00.000Z"
    })
  ];
  const out = computeTick({ settings: s, rows, nowIso: NOW, localDate: TODAY_LOCAL_DATE });
  assert.deepEqual(
    out.candidates.map((c) => c.personId),
    ["p-red-old", "p-red-new", "p-amber-old"]
  );
});

test("applyAck writes lastDigestAt and per-person memory only for included people", () => {
  const s = defaults();
  const next = applyAck(
    s,
    [
      { personId: "p-1", displayName: "Brandon", stateKey: "sk-1" },
      { personId: "p-2", displayName: "Ayo", stateKey: "sk-2" }
    ],
    NOW
  );
  assert.equal(next.lastDigestAt, NOW);
  assert.equal(next.perPerson["p-1"].lastIncludedAt, NOW);
  assert.equal(next.perPerson["p-1"].lastIncludedStateKey, "sk-1");
  assert.equal(next.perPerson["p-2"].displayName, "Ayo");
  // Original settings unchanged (immutability check)
  assert.equal(s.lastDigestAt, null);
  assert.deepEqual(s.perPerson, {});
});

test("computeTick does NOT mutate memory (only ack does)", () => {
  const s = { ...defaults(), cadence: "daily" };
  const original = JSON.stringify(s);
  const _ = computeTick({
    settings: s,
    rows: [row()],
    nowIso: NOW,
    localDate: TODAY_LOCAL_DATE
  });
  assert.equal(JSON.stringify(s), original);
});

test("applyAck preserves an existing snoozedUntil for the same person", () => {
  let s = defaults();
  s = applySnoozePerson(s, "p-1", "Brandon", "2026-06-15T00:00:00.000Z");
  s = applyAck(s, [{ personId: "p-1", displayName: "Brandon", stateKey: "sk-1" }], NOW);
  assert.equal(s.perPerson["p-1"].snoozedUntil, "2026-06-15T00:00:00.000Z");
  assert.equal(s.perPerson["p-1"].lastIncludedAt, NOW);
});

test("listSnoozedPeople hides expired snoozes and sorts by displayName", () => {
  let s = defaults();
  s = applySnoozePerson(s, "p-b", "Brandon", "2026-06-15T00:00:00.000Z");
  s = applySnoozePerson(s, "p-a", "Ayo", "2026-06-20T00:00:00.000Z");
  s = applySnoozePerson(s, "p-old", "Tim", "2026-05-01T00:00:00.000Z");
  const out = listSnoozedPeople(s, NOW);
  assert.deepEqual(
    out.map((s) => s.displayName),
    ["Ayo", "Brandon"]
  );
});

test("preview cap is respected for very large candidate lists", () => {
  const s = { ...defaults(), cadence: "daily" };
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(
      row({
        threadId: `t-${i}`,
        personId: `p-${i}`,
        personName: `Person ${i}`,
        riskLevel: i < 10 ? "RED" : "AMBER",
        lastInboundAt: `2026-05-2${i % 9}T08:00:00.000Z`
      })
    );
  }
  const out = computeTick({ settings: s, rows, nowIso: NOW, localDate: TODAY_LOCAL_DATE });
  assert.equal(out.due, true);
  assert.equal(out.candidates.length, 8, "PREVIEW_CANDIDATE_CAP");
});
