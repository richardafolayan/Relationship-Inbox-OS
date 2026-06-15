import test from "node:test";
import assert from "node:assert/strict";

// Pure helpers; no React, no Notification API needed for buildOverdueDigestTitle/Body
// (those are tested via the helper exports). For notifyOverdueReplyDigest we
// shim a minimal Notification constructor on `window` and assert the contract.
const {
  buildOverdueDigestTitle,
  buildOverdueDigestBody,
  notifyOverdueReplyDigest,
  notificationsSupported
} = await import("../apps/dashboard/lib/notifications.ts");

const {
  shouldQueryDigestTick,
  shouldAttemptDesktopDigestPing,
  summariseCandidatesForAck,
  localDateString
} = await import("../apps/dashboard/lib/overdue-digest.ts");

test("title is singular at count=1, plural otherwise", () => {
  assert.equal(buildOverdueDigestTitle(1), "1 person still needs a reply");
  assert.equal(buildOverdueDigestTitle(3), "3 people still need replies");
  assert.equal(buildOverdueDigestTitle(0), "1 person still needs a reply");
});

test("body lists up to 3 names, then 'and N others'", () => {
  const p = (n) => ({ personId: `p-${n}`, personName: n });
  assert.equal(buildOverdueDigestBody([p("Brandon")]), "Brandon is still open.");
  assert.equal(
    buildOverdueDigestBody([p("Brandon"), p("Ayo")]),
    "Brandon and Ayo are still open."
  );
  assert.equal(
    buildOverdueDigestBody([p("Brandon"), p("Ayo"), p("Timi")]),
    "Brandon, Ayo and Timi are still open."
  );
  assert.equal(
    buildOverdueDigestBody([p("Brandon"), p("Ayo"), p("Timi"), p("Sam")]),
    "Brandon, Ayo and 2 others are still open."
  );
});

test("body never uses guilt language or em dashes", () => {
  const p = (n) => ({ personId: `p-${n}`, personName: n });
  const samples = [
    buildOverdueDigestBody([]),
    buildOverdueDigestBody([p("Brandon")]),
    buildOverdueDigestBody([p("Brandon"), p("Ayo")]),
    buildOverdueDigestBody([p("Brandon"), p("Ayo"), p("Timi")]),
    buildOverdueDigestBody([p("Brandon"), p("Ayo"), p("Timi"), p("Sam"), p("Jo")])
  ];
  const banned = [
    /neglect/i,
    /ignoring/i,
    /you have/i, // imperative guilt framing
    /not a /i, // "not a nagging system" / "not a dashboard" framing
    /—|–/ // em / en dashes
  ];
  for (const text of samples) {
    for (const re of banned) {
      assert.ok(!re.test(text), `banned phrase ${re} found in ${JSON.stringify(text)}`);
    }
  }
});

test("shouldQueryDigestTick: cadence and quiet hours are the only gates", () => {
  // The bell entry is the digest's primary surface, so a due digest must be
  // queried (and delivered) even without desktop permission and even while
  // the tab is visible. Only cadence-off and quiet hours suppress it.
  const base = { cadence: "daily", quietHoursActive: false };
  assert.equal(shouldQueryDigestTick(base), true);
  assert.equal(shouldQueryDigestTick({ ...base, cadence: "weekly" }), true);
  assert.equal(shouldQueryDigestTick({ ...base, cadence: "off" }), false);
  assert.equal(shouldQueryDigestTick({ ...base, quietHoursActive: true }), false);
});

test("shouldAttemptDesktopDigestPing: optional extra needs support + grant + a hidden tab", () => {
  const base = {
    notificationsSupported: true,
    notificationPermission: "granted",
    documentVisibility: "hidden"
  };
  assert.equal(shouldAttemptDesktopDigestPing(base), true);
  // No desktop permission no longer kills the digest, it only skips the ping.
  assert.equal(shouldAttemptDesktopDigestPing({ ...base, notificationPermission: "default" }), false);
  assert.equal(shouldAttemptDesktopDigestPing({ ...base, notificationPermission: "denied" }), false);
  assert.equal(
    shouldAttemptDesktopDigestPing({
      ...base,
      notificationsSupported: false,
      notificationPermission: "unsupported"
    }),
    false
  );
  // Looking at the app already shows the queue; the OS ping would duplicate it.
  assert.equal(shouldAttemptDesktopDigestPing({ ...base, documentVisibility: "visible" }), false);
  // No document (SSR-ish edge) counts as not-visible, matching the old gate.
  assert.equal(shouldAttemptDesktopDigestPing({ ...base, documentVisibility: "unknown" }), true);
});

test("summariseCandidatesForAck dedupes by personId and keeps order", () => {
  const candidates = [
    { personId: "p-1", personName: "A", threadId: "t-1", riskLevel: "RED", lastInboundAt: null, stateKey: "k1" },
    { personId: "p-2", personName: "B", threadId: "t-2", riskLevel: "RED", lastInboundAt: null, stateKey: "k2" },
    { personId: "p-1", personName: "A", threadId: "t-3", riskLevel: "AMBER", lastInboundAt: null, stateKey: "k1b" }
  ];
  const out = summariseCandidatesForAck(candidates);
  assert.deepEqual(out, [
    { personId: "p-1", displayName: "A", stateKey: "k1" },
    { personId: "p-2", displayName: "B", stateKey: "k2" }
  ]);
});

test("localDateString returns a YYYY-MM-DD string in local zone", () => {
  const s = localDateString(new Date(2026, 4, 26, 12, 0, 0));
  assert.equal(s, "2026-05-26");
  assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
});

test("notifyOverdueReplyDigest returns false when Notification is unsupported", () => {
  const previous = globalThis.window;
  // Reset to a window with no Notification API
  globalThis.window = { focus() {} };
  try {
    assert.equal(notificationsSupported(), false);
    const result = notifyOverdueReplyDigest(
      [{ personId: "p-1", personName: "Brandon" }],
      () => {}
    );
    assert.equal(result, false);
  } finally {
    globalThis.window = previous;
  }
});

test("notifyOverdueReplyDigest creates exactly one Notification, with our tag, when granted", () => {
  const constructed = [];
  class FakeNotification {
    constructor(title, init) {
      constructed.push({ title, init });
      this.onclick = null;
    }
    close() {
      this.closed = true;
    }
    static permission = "granted";
    static requestPermission() {
      return Promise.resolve("granted");
    }
  }
  const previous = globalThis.window;
  globalThis.window = { Notification: FakeNotification, focus() {} };
  // notifications.ts inspects `window.Notification` via `"Notification" in window`,
  // and reads `Notification.permission` from the actual global. Stub both.
  const previousNotification = globalThis.Notification;
  globalThis.Notification = FakeNotification;
  try {
    let openedToday = 0;
    const ok = notifyOverdueReplyDigest(
      [
        { personId: "p-1", personName: "Brandon" },
        { personId: "p-2", personName: "Ayo" }
      ],
      () => {
        openedToday += 1;
      }
    );
    assert.equal(ok, true);
    assert.equal(constructed.length, 1);
    assert.equal(constructed[0].title, "2 people still need replies");
    assert.equal(constructed[0].init.body, "Brandon and Ayo are still open.");
    assert.equal(constructed[0].init.tag, "inbox-os:overdue-digest");
  } finally {
    globalThis.window = previous;
    if (previousNotification === undefined) {
      delete globalThis.Notification;
    } else {
      globalThis.Notification = previousNotification;
    }
  }
});

test("notifyOverdueReplyDigest returns false when permission is not granted", () => {
  class DeniedNotification {
    static permission = "default";
  }
  const previous = globalThis.window;
  const previousNotification = globalThis.Notification;
  globalThis.window = { Notification: DeniedNotification };
  globalThis.Notification = DeniedNotification;
  try {
    const ok = notifyOverdueReplyDigest(
      [{ personId: "p-1", personName: "Brandon" }],
      () => {}
    );
    assert.equal(ok, false);
  } finally {
    globalThis.window = previous;
    if (previousNotification === undefined) {
      delete globalThis.Notification;
    } else {
      globalThis.Notification = previousNotification;
    }
  }
});

test("notifyOverdueReplyDigest returns false on empty candidate list", () => {
  class GrantedNotification {
    constructor() {}
    static permission = "granted";
  }
  const previous = globalThis.window;
  const previousNotification = globalThis.Notification;
  globalThis.window = { Notification: GrantedNotification };
  globalThis.Notification = GrantedNotification;
  try {
    const ok = notifyOverdueReplyDigest([], () => {});
    assert.equal(ok, false);
  } finally {
    globalThis.window = previous;
    if (previousNotification === undefined) {
      delete globalThis.Notification;
    } else {
      globalThis.Notification = previousNotification;
    }
  }
});
