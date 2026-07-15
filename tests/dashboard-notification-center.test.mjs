import test from "node:test";
import assert from "node:assert/strict";

// The notification center keeps every new-message notice until the operator
// dismisses it, so a toast that cleared itself (or a desktop ping that fired
// while they were away, or a quiet-hours silence) is still reviewable from
// the bell. Pure list reducers + a localStorage-backed wrapper, both covered
// here without a DOM.
const {
  addNotifications,
  removeNotification,
  removeNotifications,
  markNotificationsSeen,
  markAllNotificationsSeen,
  unseenNotificationCount,
  parseStoredNotifications,
  readCenterNotifications,
  recordNewMessageNotifications,
  dismissCenterNotification,
  dismissCenterNotifications,
  clearCenterNotifications,
  markCenterNotificationsSeen,
  markAllCenterNotificationsSeen,
  onCenterNotificationsChange,
  recordOverdueDigestNotification,
  NOTIFICATION_CENTER_CAP,
  NOTIFICATION_CENTER_STORAGE_KEY,
  OVERDUE_DIGEST_NOTIFICATION_ID
} = await import("../apps/dashboard/lib/notification-center.ts");

function entry(overrides = {}) {
  return {
    id: "t-1",
    title: "Davina messaged you",
    body: "Wants to confirm Friday's call.",
    href: "/thread/t-1",
    at: 1000,
    seen: false,
    ...overrides
  };
}

// Minimal InboxRow stand-in: recordNewMessageNotifications only reads the
// fields buildNewMessageNotice reads.
function row(overrides = {}) {
  return {
    id: "t-1",
    personName: "Davina",
    whatTheyWant: "Wants to confirm Friday's call.",
    preview: "Hey, are we still on for Friday?",
    lastInboundAt: "2026-05-28T09:00:00.000Z",
    needsReply: true,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Pure reducers.
// ---------------------------------------------------------------------------

test("addNotifications: prepends newest first and dedupes by thread id", () => {
  const existing = [entry({ id: "t-1", at: 1000, seen: true }), entry({ id: "t-2", at: 900 })];
  const next = addNotifications(existing, [entry({ id: "t-1", at: 2000, seen: false })]);
  assert.deepEqual(
    next.map((n) => n.id),
    ["t-1", "t-2"]
  );
  // The newer notice replaced the old entry entirely: front of the list,
  // fresh timestamp, and unseen again (it IS a new message).
  assert.equal(next[0].at, 2000);
  assert.equal(next[0].seen, false);
});

test("addNotifications: caps the list, dropping the oldest", () => {
  const existing = Array.from({ length: NOTIFICATION_CENTER_CAP }, (_, i) =>
    entry({ id: `old-${i}`, at: i })
  );
  const next = addNotifications(existing, [entry({ id: "fresh", at: 99999 })]);
  assert.equal(next.length, NOTIFICATION_CENTER_CAP);
  assert.equal(next[0].id, "fresh");
  // The tail entry fell off; everything else shifted intact.
  assert.equal(
    next.some((n) => n.id === `old-${NOTIFICATION_CENTER_CAP - 1}`),
    false
  );
});

test("removeNotification removes only the target", () => {
  const items = [entry({ id: "t-1" }), entry({ id: "t-2" })];
  assert.deepEqual(
    removeNotification(items, "t-1").map((n) => n.id),
    ["t-2"]
  );
  assert.equal(removeNotification(items, "missing").length, 2);
});

test("removeNotifications removes only the targeted entries", () => {
  const items = [entry({ id: "demo-1" }), entry({ id: "real-1" }), entry({ id: "demo-2" })];
  assert.deepEqual(
    removeNotifications(items, ["demo-1", "demo-2"]).map((notification) => notification.id),
    ["real-1"]
  );
});

test("markNotificationsSeen flips only the targets; markAllNotificationsSeen flips everything", () => {
  const items = [entry({ id: "t-1" }), entry({ id: "t-2" }), entry({ id: "t-3", seen: true })];
  const some = markNotificationsSeen(items, ["t-1", "missing"]);
  assert.deepEqual(
    some.map((n) => n.seen),
    [true, false, true]
  );
  const all = markAllNotificationsSeen(items);
  assert.deepEqual(
    all.map((n) => n.seen),
    [true, true, true]
  );
});

test("unseenNotificationCount counts only unseen entries", () => {
  assert.equal(unseenNotificationCount([]), 0);
  assert.equal(
    unseenNotificationCount([entry({ seen: true }), entry({ id: "t-2" }), entry({ id: "t-3" })]),
    2
  );
});

test("parseStoredNotifications survives null, garbage, and wrong shapes", () => {
  assert.deepEqual(parseStoredNotifications(null), []);
  assert.deepEqual(parseStoredNotifications("not json {"), []);
  assert.deepEqual(parseStoredNotifications('{"a":1}'), []);
  // Invalid entries are filtered, valid ones kept.
  const mixed = JSON.stringify([entry(), { id: "broken" }, 42, null]);
  const parsed = parseStoredNotifications(mixed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "t-1");
});

// ---------------------------------------------------------------------------
// Storage-backed API. notification-center.ts only touches window inside its
// functions, so a shim swapped in around each call is enough - same pattern
// as the Notification stubs in dashboard-new-message-notify.test.mjs.
// ---------------------------------------------------------------------------

function withWindow(run, { throwOnSet = false } = {}) {
  const store = new Map();
  const listeners = new Map();
  const dispatched = [];
  const win = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        if (throwOnSet) throw new Error("quota exceeded");
        store.set(key, String(value));
      },
      removeItem: (key) => {
        store.delete(key);
      }
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event) => {
      dispatched.push(event.type);
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    }
  };
  const prevWindow = globalThis.window;
  globalThis.window = win;
  try {
    return run({ store, dispatched, win });
  } finally {
    globalThis.window = prevWindow;
  }
}

test("recordNewMessageNotifications persists notices newest-first and announces the change", () => {
  withWindow(({ store, dispatched }) => {
    recordNewMessageNotifications([row()], 5000);
    recordNewMessageNotifications(
      [row({ id: "t-2", personName: "Joseph", whatTheyWant: "Sent the deck over." })],
      6000
    );

    const stored = JSON.parse(store.get(NOTIFICATION_CENTER_STORAGE_KEY));
    assert.deepEqual(
      stored.map((n) => n.id),
      ["t-2", "t-1"]
    );
    assert.equal(stored[0].title, "Joseph messaged you");
    assert.equal(stored[0].body, "Sent the deck over.");
    assert.equal(stored[0].href, "/thread/t-2");
    assert.equal(stored[0].at, 6000);
    assert.equal(stored[0].seen, false);
    assert.equal(dispatched.length, 2);
  });
});

test("recordNewMessageNotifications with no rows is a complete no-op", () => {
  withWindow(({ store, dispatched }) => {
    recordNewMessageNotifications([], 5000);
    assert.equal(store.has(NOTIFICATION_CENTER_STORAGE_KEY), false);
    assert.equal(dispatched.length, 0);
  });
});

test("a new message in an already-listed thread replaces its entry and resets seen", () => {
  withWindow(({ store }) => {
    recordNewMessageNotifications([row()], 5000);
    markAllCenterNotificationsSeen();
    recordNewMessageNotifications([row({ whatTheyWant: "Second ask." })], 7000);

    const stored = JSON.parse(store.get(NOTIFICATION_CENTER_STORAGE_KEY));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].body, "Second ask.");
    assert.equal(stored[0].at, 7000);
    assert.equal(stored[0].seen, false);
  });
});

// ---------------------------------------------------------------------------
// Overdue-reply digest entry (#360). The bell is the digest's primary
// delivery surface: it must land here whether or not desktop permission was
// granted, so the regression to pin is "no permission still produces a bell
// entry" (the old scheduler silently dropped the whole digest instead).
// ---------------------------------------------------------------------------

const digestPeople = [
  { personId: "p-1", personName: "Brandon" },
  { personId: "p-2", personName: "Ayo" }
];

test("recordOverdueDigestNotification lands one /today entry built from the digest copy", () => {
  withWindow(({ store, dispatched }) => {
    recordOverdueDigestNotification(digestPeople, 5000);

    const stored = JSON.parse(store.get(NOTIFICATION_CENTER_STORAGE_KEY));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, OVERDUE_DIGEST_NOTIFICATION_ID);
    assert.equal(stored[0].title, "2 people still need replies");
    assert.equal(stored[0].body, "Brandon and Ayo are still open.");
    assert.equal(stored[0].href, "/today");
    assert.equal(stored[0].at, 5000);
    assert.equal(stored[0].seen, false);
    assert.equal(dispatched.length, 1);
  });
});

test("a newer digest replaces the previous bell entry instead of piling up", () => {
  withWindow(({ store }) => {
    recordOverdueDigestNotification(digestPeople, 5000);
    markAllCenterNotificationsSeen();
    recordOverdueDigestNotification([{ personId: "p-3", personName: "Timi" }], 9000);

    const stored = JSON.parse(store.get(NOTIFICATION_CENTER_STORAGE_KEY));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, OVERDUE_DIGEST_NOTIFICATION_ID);
    assert.equal(stored[0].title, "1 person still needs a reply");
    assert.equal(stored[0].body, "Timi is still open.");
    assert.equal(stored[0].at, 9000);
    assert.equal(stored[0].seen, false);
  });
});

test("the digest entry coexists with new-message entries without clobbering them", () => {
  withWindow(() => {
    recordNewMessageNotifications([row()], 5000);
    recordOverdueDigestNotification(digestPeople, 6000);

    const items = readCenterNotifications();
    assert.deepEqual(
      items.map((n) => n.id),
      [OVERDUE_DIGEST_NOTIFICATION_ID, "t-1"]
    );
    // Dismissing the digest leaves the message notice alone.
    dismissCenterNotification(OVERDUE_DIGEST_NOTIFICATION_ID);
    assert.deepEqual(
      readCenterNotifications().map((n) => n.id),
      ["t-1"]
    );
  });
});

test("recordOverdueDigestNotification with no people is a complete no-op", () => {
  withWindow(({ store, dispatched }) => {
    recordOverdueDigestNotification([], 5000);
    assert.equal(store.has(NOTIFICATION_CENTER_STORAGE_KEY), false);
    assert.equal(dispatched.length, 0);
  });
});

test("dismiss / clear / mark-seen round-trip through storage", () => {
  withWindow(() => {
    recordNewMessageNotifications([row(), row({ id: "t-2", personName: "Joseph" })], 5000);

    markCenterNotificationsSeen(["t-1"]);
    let items = readCenterNotifications();
    assert.equal(unseenNotificationCount(items), 1);

    markAllCenterNotificationsSeen();
    items = readCenterNotifications();
    assert.equal(unseenNotificationCount(items), 0);
    assert.equal(items.length, 2);

    dismissCenterNotification("t-2");
    items = readCenterNotifications();
    assert.deepEqual(
      items.map((n) => n.id),
      ["t-1"]
    );

    clearCenterNotifications();
    assert.deepEqual(readCenterNotifications(), []);
  });
});

test("dismissCenterNotifications clears demo notices without touching real or system entries", () => {
  withWindow(() => {
    recordNewMessageNotifications(
      [row({ id: "demo-1" }), row({ id: "real-1" }), row({ id: "demo-2" })],
      5000
    );
    recordOverdueDigestNotification(digestPeople, 6000);

    dismissCenterNotifications(["demo-1", "demo-2"]);

    assert.deepEqual(
      readCenterNotifications().map((notification) => notification.id),
      [OVERDUE_DIGEST_NOTIFICATION_ID, "real-1"]
    );
  });
});

test("onCenterNotificationsChange fires for same-tab writes and matching cross-tab storage events", () => {
  withWindow(({ win }) => {
    let calls = 0;
    const off = onCenterNotificationsChange(() => {
      calls += 1;
    });

    recordNewMessageNotifications([row()], 5000);
    assert.equal(calls, 1);

    // Cross-tab: the browser fires a `storage` event. Only this key (or a
    // full localStorage.clear(), key === null) should re-render the bell.
    win.dispatchEvent({ type: "storage", key: NOTIFICATION_CENTER_STORAGE_KEY });
    assert.equal(calls, 2);
    win.dispatchEvent({ type: "storage", key: null });
    assert.equal(calls, 3);
    win.dispatchEvent({ type: "storage", key: "some_other_key" });
    assert.equal(calls, 3);

    off();
    recordNewMessageNotifications([row({ id: "t-9" })], 6000);
    assert.equal(calls, 3);
  });
});

test("a throwing localStorage (quota / privacy mode) never throws out of the API", () => {
  withWindow(
    ({ dispatched }) => {
      assert.doesNotThrow(() => recordNewMessageNotifications([row()], 5000));
      // The write failed but the change event still fans out; readers just
      // see the unchanged (empty) list.
      assert.equal(dispatched.length, 1);
      assert.deepEqual(readCenterNotifications(), []);
    },
    { throwOnSet: true }
  );
});

test("showToast forwards the center interplay hooks to the dispatched toast", async () => {
  // The 30s new-message toast carries onManualDismiss/onActivate so the
  // ToastHost can mirror an explicit wave-away (mark seen) or click-through
  // (entry handled) into the center. If feedback.ts ever drops these fields
  // the interplay dies silently - pin the pass-through.
  const { showToast } = await import("../apps/dashboard/lib/feedback.ts");
  const prevWindow = globalThis.window;
  const dispatched = [];
  globalThis.window = {
    dispatchEvent(event) {
      dispatched.push(event.detail);
      return true;
    }
  };
  try {
    const onManualDismiss = () => {};
    const onActivate = () => {};
    showToast({ kind: "info", title: "Davina messaged you", onManualDismiss, onActivate });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].onManualDismiss, onManualDismiss);
    assert.equal(dispatched[0].onActivate, onActivate);
  } finally {
    globalThis.window = prevWindow;
  }
});

test("without a window (SSR) every entry point is a safe no-op", () => {
  const prevWindow = globalThis.window;
  // eslint-disable-next-line no-undefined
  globalThis.window = undefined;
  try {
    assert.deepEqual(readCenterNotifications(), []);
    assert.doesNotThrow(() => recordNewMessageNotifications([row()], 5000));
    assert.doesNotThrow(() => recordOverdueDigestNotification(digestPeople, 5000));
    assert.doesNotThrow(() => dismissCenterNotification("t-1"));
    assert.doesNotThrow(() => dismissCenterNotifications(["t-1"]));
    assert.doesNotThrow(() => clearCenterNotifications());
    assert.doesNotThrow(() => markCenterNotificationsSeen(["t-1"]));
    assert.doesNotThrow(() => markAllCenterNotificationsSeen());
    const off = onCenterNotificationsChange(() => {});
    assert.doesNotThrow(off);
  } finally {
    globalThis.window = prevWindow;
  }
});

// ---------------------------------------------------------------------------
// Pilot R-0091 (#758): replying to a thread resolves its notice.
// ---------------------------------------------------------------------------

const { pruneRepliedNotifications, pruneRepliedCenterNotifications } = await import(
  "../apps/dashboard/lib/notification-center.ts"
);

test("pruneRepliedNotifications drops entries whose thread now shows a reply", () => {
  const existing = [
    entry({ id: "t-1" }),
    entry({ id: "t-2" }),
    entry({ id: "t-3" })
  ];
  const next = pruneRepliedNotifications(existing, [
    { id: "t-1", needsReply: false, lastMessageDirection: "OUT" },
    { id: "t-2", needsReply: true, lastMessageDirection: "IN" },
    { id: "t-3", needsReply: true, lastMessageDirection: "OUT" }
  ]);
  // t-1 replied (both signals), t-3's newest message is outbound, t-2 still
  // waits on the operator.
  assert.deepEqual(next.map((n) => n.id), ["t-2"]);
});

test("pruneRepliedNotifications leaves non-thread entries and missing threads alone", () => {
  const existing = [
    entry({ id: OVERDUE_DIGEST_NOTIFICATION_ID, href: "/today" }),
    entry({ id: "t-gone" }),
    entry({ id: "t-1" })
  ];
  // t-gone is absent from rows (archived / fetch hiccup): stays. The digest
  // id never matches a row: stays.
  const next = pruneRepliedNotifications(existing, [
    { id: "t-1", needsReply: false, lastMessageDirection: "OUT" }
  ]);
  assert.deepEqual(next.map((n) => n.id), [OVERDUE_DIGEST_NOTIFICATION_ID, "t-gone"]);
});

test("pruneRepliedNotifications with no replied rows returns the same list", () => {
  const existing = [entry({ id: "t-1" })];
  const next = pruneRepliedNotifications(existing, [
    { id: "t-1", needsReply: true, lastMessageDirection: "IN" }
  ]);
  assert.equal(next, existing);
});

test("pruneRepliedCenterNotifications writes only when something was removed", () => {
  withWindow(({ store, dispatched }) => {
    recordNewMessageNotifications([row({ id: "t-1" }), row({ id: "t-2" })], 5000);
    const writesBefore = dispatched.length;
    // Nothing replied: no write, no fan-out.
    pruneRepliedCenterNotifications([
      { id: "t-1", needsReply: true, lastMessageDirection: "IN" }
    ]);
    assert.equal(dispatched.length, writesBefore);
    // t-1 replied: entry removed, change announced.
    pruneRepliedCenterNotifications([
      { id: "t-1", needsReply: false, lastMessageDirection: "OUT" }
    ]);
    assert.equal(dispatched.length, writesBefore + 1);
    const kept = parseStoredNotifications(store.get(NOTIFICATION_CENTER_STORAGE_KEY));
    assert.deepEqual(kept.map((n) => n.id), ["t-2"]);
  });
});

test("pruneRepliedCenterNotifications without a window is a safe no-op", () => {
  const prevWindow = globalThis.window;
  // eslint-disable-next-line no-undefined
  globalThis.window = undefined;
  try {
    assert.doesNotThrow(() =>
      pruneRepliedCenterNotifications([
        { id: "t-1", needsReply: false, lastMessageDirection: "OUT" }
      ])
    );
  } finally {
    globalThis.window = prevWindow;
  }
});
