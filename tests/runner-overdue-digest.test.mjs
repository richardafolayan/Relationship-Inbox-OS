import test from "node:test";
import assert from "node:assert/strict";

// Pure service. No Prisma, no Express. Imports the .ts sources through the tsx
// loader (the same pattern dashboard-horizon.test.mjs uses) so the runner
// service and core SOURCE are exercised directly.
//
// IMPORTANT — this file's verdict depends on the BUILT @inbox-os/core, not only
// on the source imports below. `computeTick` (runner service) resolves
// `isDigestDue` / `buildStateKey` from the *package* `@inbox-os/core` (its
// compiled dist), NOT from `../packages/core/src`. So a STALE core dist makes
// computeTick silently run the pre-#628 UTC-prefix rule while the source-level
// unit tests here keep passing — and the resulting "computeTick … not due"
// failure *looks* like a timezone bug but is really a stale build. (That is the
// actual #628 footgun: it fails identically in every timezone when the dist is
// stale, and passes in every timezone when fresh — see the GUARD and TZ-matrix
// tests below.) The runner-service import already requires the dist to resolve,
// so importing it directly adds no new prerequisite.
//
// Focused run — MUST rebuild core first (a bare `node --test` does NOT):
//   npm run build --workspace @inbox-os/core \
//     && node --import tsx --test tests/runner-overdue-digest.test.mjs
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
// The BUILT package copy — the exact module `computeTick` imports. Used by the
// source/dist parity GUARD below so a stale dist fails loudly and actionably
// instead of masquerading as a timezone bug.
const builtCore = await import("@inbox-os/core");
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

const REBUILD_HINT =
  "Rebuild the core package: `npm run build --workspace @inbox-os/core`";

test("GUARD: built @inbox-os/core implements the #628 local-date rule (a stale dist is the real cause of the 'timezone' failure)", () => {
  // `computeTick` imports `isDigestDue` from the BUILT @inbox-os/core, not from
  // this test's source import. If that dist is stale (pre-#628) it ignores the
  // 5th arg (lastDigestLocalDate) and falls back to the UTC prefix — which makes
  // the #628 computeTick test below fail with a misleading "not due" in EVERY
  // timezone. Pin the built copy directly so a stale build fails HERE, loudly
  // and actionably, rather than looking like a timezone determinism bug.
  assert.equal(
    typeof builtCore.isDigestDue,
    "function",
    `built @inbox-os/core must export isDigestDue. ${REBUILD_HINT}`
  );
  // West-of-UTC evening fire: persisted local date is YESTERDAY → the next local
  // morning MUST be due. The pre-#628 dist ignores lastDigestLocalDate and
  // returns false here.
  assert.equal(
    builtCore.isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-25"),
    true,
    `STALE built @inbox-os/core: it ignores lastDigestLocalDate (pre-#628). ${REBUILD_HINT}`
  );
  // Same persisted local date as today → already fired today → not due.
  assert.equal(
    builtCore.isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-26"),
    false,
    `STALE built @inbox-os/core: same-day suppression broken. ${REBUILD_HINT}`
  );
  // The built and source copies must agree on the canonical #628 inputs — if
  // they diverge, the dist is out of date with the source the tests reason about.
  for (const lastLocal of ["2026-05-25", "2026-05-26", null]) {
    assert.equal(
      builtCore.isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", lastLocal),
      isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", lastLocal),
      `built and source @inbox-os/core disagree (lastDigestLocalDate=${lastLocal}). ${REBUILD_HINT}`
    );
  }
});

test("default settings are cadence=off, no memory", () => {
  assert.deepEqual(defaults(), {
    cadence: "off",
    lastDigestAt: null,
    lastDigestLocalDate: null,
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

test("isDigestDue: daily compares the persisted LOCAL date, not the UTC prefix (#628)", () => {
  // US-Pacific (UTC-7) operator: a digest fired at 18:00 local on May 25 acks
  // with a UTC timestamp that has already rolled to May 26 (01:00Z) but a LOCAL
  // date of May 25. The next local morning (May 26) it MUST be due. The old code
  // derived "2026-05-26" from the UTC prefix and wrongly suppressed the day.
  assert.equal(
    isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-25"),
    true,
    "evening fire west of UTC: the next local day is due (was skipped pre-#628)"
  );
  // Same LOCAL date as today => already fired today => not due, even though the
  // UTC prefix ("2026-05-26") happens to equal today's local date here.
  assert.equal(
    isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-26"),
    false,
    "already fired today (local) => not due"
  );
  // Legacy row (no persisted local date) falls back to the UTC prefix.
  assert.equal(
    isDigestDue("daily", "2026-05-25T08:00:00.000Z", NOW, "2026-05-26", null),
    true,
    "legacy fallback: yesterday's UTC prefix still allows today"
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

test("applyAck persists the dashboard-local date for the daily cadence (#628)", () => {
  const next = applyAck(
    { ...defaults(), cadence: "daily" },
    [{ personId: "p-1", displayName: "Brandon", stateKey: "sk-1" }],
    "2026-05-26T01:00:00.000Z",
    "2026-05-25"
  );
  // lastDigestAt is the UTC instant; lastDigestLocalDate is the operator's day.
  assert.equal(next.lastDigestAt, "2026-05-26T01:00:00.000Z");
  assert.equal(next.lastDigestLocalDate, "2026-05-25");
  // A legacy caller that omits localDate leaves it null (daily falls back to UTC prefix).
  const legacy = applyAck({ ...defaults(), cadence: "daily" }, [{ personId: "p-1", displayName: "B", stateKey: "k" }], NOW);
  assert.equal(legacy.lastDigestLocalDate, null);
});

test("computeTick: daily is due the next local morning after an evening fire west of UTC (#628)", () => {
  // Full path: ack at 18:00 PDT (May 25 local, 01:00Z May 26), then tick the next
  // local morning (May 26 local, ~08:00 PDT = 15:00Z). Must be due — the pre-#628
  // code derived the same UTC date for both and reported not_due, skipping the day.
  // Zone-invariance of this same verdict is pinned separately by the TZ-matrix
  // test below; the GUARD test pins that the BUILT core honours it too.
  const acked = applyAck(
    { ...defaults(), cadence: "daily" },
    [{ personId: "p-1", displayName: "Brandon", stateKey: "sk-1" }],
    "2026-05-26T01:00:00.000Z",
    "2026-05-25"
  );
  const result = computeTick({
    settings: acked,
    rows: [row()],
    nowIso: "2026-05-26T15:00:00.000Z",
    localDate: "2026-05-26"
  });
  assert.equal(result.due, true, "the next local day must be due");
  assert.equal(result.reason, "due");

  // Ticking again the SAME local day after that fire is not due.
  const sameDay = computeTick({
    settings: applyAck(acked, [{ personId: "p-1", displayName: "Brandon", stateKey: "sk-2" }], "2026-05-26T15:00:00.000Z", "2026-05-26"),
    rows: [row()],
    nowIso: "2026-05-26T20:00:00.000Z",
    localDate: "2026-05-26"
  });
  assert.equal(sameDay.due, false, "already fired today (local)");
  assert.equal(sameDay.reason, "not_due");
});

// ---- Timezone determinism (#628 follow-up) ----------------------------------
//
// The daily cadence compares LOCAL calendar-date STRINGS, so its verdict must
// not depend on the process timezone. Node re-reads `process.env.TZ` at runtime
// for Date's local methods, so we can prove invariance in-process: run the same
// decision under UTC, Europe/London (BST, east of UTC) and America/New_York
// (EDT, west of UTC) and assert byte-identical results. If a future change
// reintroduces a UTC-vs-local mix (e.g. deriving a calendar date from a
// near-midnight UTC instant via `new Date(...).getDate()`), the verdict would
// diverge across these zones and these tests fail. The 01:00Z instant is chosen
// because it lands on a DIFFERENT local date per zone:
//   01:00Z → 2026-05-26 (UTC) · 2026-05-26 02:00 (London) · 2026-05-25 21:00 (NY)

const TZ_MATRIX = ["UTC", "Europe/London", "America/New_York"];

function inTimezone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

function acrossZones(fn) {
  return TZ_MATRIX.map((tz) => inTimezone(tz, fn));
}

test("isDigestDue: daily verdict is identical under UTC / Europe-London / America-New_York (#628)", () => {
  // West-of-UTC evening fire (persisted local date = yesterday) → next local
  // morning is due, in every zone.
  assert.deepEqual(
    acrossZones(() =>
      isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-25")
    ),
    [true, true, true],
    "next-local-morning due-ness must not depend on the process timezone"
  );
  // Already fired today (persisted local date = today) → not due, in every zone.
  assert.deepEqual(
    acrossZones(() =>
      isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", "2026-05-26")
    ),
    [false, false, false],
    "already-fired-today suppression must not depend on the process timezone"
  );
  // Legacy fallback (no persisted local date): the UTC-prefix branch is a pure
  // string slice, so it too must be zone-invariant even for a near-midnight
  // instant whose LOCAL date differs by zone.
  assert.deepEqual(
    acrossZones(() =>
      isDigestDue("daily", "2026-05-26T01:00:00.000Z", NOW, "2026-05-26", null)
    ),
    [false, false, false],
    "legacy UTC-prefix fallback must be zone-invariant"
  );
});

test("computeTick: the #628 next-local-morning path is due under every timezone", () => {
  const acked = applyAck(
    { ...defaults(), cadence: "daily" },
    [{ personId: "p-1", displayName: "Brandon", stateKey: "sk-1" }],
    "2026-05-26T01:00:00.000Z",
    "2026-05-25"
  );
  const verdicts = acrossZones(() => {
    const r = computeTick({
      settings: acked,
      rows: [row()],
      nowIso: "2026-05-26T15:00:00.000Z",
      localDate: "2026-05-26"
    });
    return `${r.due}:${r.reason}`;
  });
  assert.deepEqual(
    verdicts,
    ["true:due", "true:due", "true:due"],
    "computeTick's #628 verdict must be identical in every timezone"
  );
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
