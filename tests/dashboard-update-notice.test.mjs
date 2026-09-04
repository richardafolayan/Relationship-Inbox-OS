import test from "node:test";
import assert from "node:assert/strict";

// Update-available notices: a newer pilot build surfaces like a new message
// (one 30s toast + a notification-center entry) but only ONCE per version,
// quietly during quiet
// hours, and the center entry clears itself once the app is up to date.
// The decision logic is pure (planUpdateNotice); the stamp helpers wrap
// localStorage with the same fail-quiet rules as the rest of the dashboard.
const {
  buildUpdateNotice,
  planUpdateNotice,
  readNotifiedUpdateVersion,
  writeNotifiedUpdateVersion,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTICE_HREF,
  UPDATE_NOTICE_ID,
  UPDATE_NOTICE_STAMP_KEY
} = await import("../apps/dashboard/lib/update-notice.ts");
const { readCenterNotifications, recordCenterNotifications, dismissCenterNotification } =
  await import("../apps/dashboard/lib/notification-center.ts");

// Same window shim pattern as dashboard-notification-center.test.mjs.
function withWindow(run, { throwOnSet = false } = {}) {
  const store = new Map();
  const listeners = new Map();
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
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true
  };
  const prevWindow = globalThis.window;
  globalThis.window = win;
  try {
    return run({ store });
  } finally {
    globalThis.window = prevWindow;
  }
}

// ---------------------------------------------------------------------------
// Notice shape.
// ---------------------------------------------------------------------------

test("buildUpdateNotice names the version and points at the anchored card", () => {
  const notice = buildUpdateNotice("0.2.0");
  assert.equal(notice.title, "Update available v0.2.0");
  assert.equal(notice.href, "/settings#app-updates");
  assert.equal(notice.href, UPDATE_NOTICE_HREF);
  assert.ok(notice.body.length > 0);
});

test("replacement update notices name the actual host without guessing Mac", () => {
  assert.equal(
    buildUpdateNotice("0.2.0", "replace_app", "pc").body,
    "A new Windows build is ready. Open Settings for safe install steps."
  );
  assert.equal(
    buildUpdateNotice("0.2.0", "replace_app", "mac").body,
    "A new Mac build is ready. Open Settings for safe install steps."
  );
  assert.equal(
    buildUpdateNotice("0.2.0", "replace_app", "computer").body,
    "A new build for this computer is ready. Open Settings for safe install steps."
  );
});

test("the check cadence is quick but nowhere near the inbox poll", () => {
  assert.ok(UPDATE_CHECK_INTERVAL_MS >= 60 * 1000);
  assert.ok(UPDATE_CHECK_INTERVAL_MS <= 5 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// planUpdateNotice - pure decision table.
// ---------------------------------------------------------------------------

test("up to date clears any lingering reminder", () => {
  const plan = planUpdateNotice({
    updateAvailable: false,
    latestVersion: "0.1.9",
    notifiedVersion: "0.1.9",
    quietHoursActive: false
  });
  assert.equal(plan, "clear");
});

test("a brand-new version records and toasts", () => {
  const plan = planUpdateNotice({
    updateAvailable: true,
    latestVersion: "0.2.0",
    notifiedVersion: null,
    quietHoursActive: false
  });
  assert.equal(plan, "record-and-toast");
});

test("the same version never announces twice", () => {
  const plan = planUpdateNotice({
    updateAvailable: true,
    latestVersion: "0.2.0",
    notifiedVersion: "0.2.0",
    quietHoursActive: false
  });
  assert.equal(plan, "none");
});

test("a newer version supersedes an older announcement", () => {
  const plan = planUpdateNotice({
    updateAvailable: true,
    latestVersion: "0.2.1",
    notifiedVersion: "0.2.0",
    quietHoursActive: false
  });
  assert.equal(plan, "record-and-toast");
});

test("quiet hours keep the record but skip the toast", () => {
  const plan = planUpdateNotice({
    updateAvailable: true,
    latestVersion: "0.2.0",
    notifiedVersion: null,
    quietHoursActive: true
  });
  assert.equal(plan, "record");
});

// ---------------------------------------------------------------------------
// Stamp helpers - localStorage wrappers that never throw.
// ---------------------------------------------------------------------------

test("the stamp round-trips through localStorage", () => {
  withWindow(({ store }) => {
    assert.equal(readNotifiedUpdateVersion(), null);
    writeNotifiedUpdateVersion("0.2.0");
    assert.equal(store.get(UPDATE_NOTICE_STAMP_KEY), "0.2.0");
    assert.equal(readNotifiedUpdateVersion(), "0.2.0");
  });
});

test("a throwing localStorage degrades quietly", () => {
  withWindow(
    () => {
      assert.doesNotThrow(() => writeNotifiedUpdateVersion("0.2.0"));
      assert.equal(readNotifiedUpdateVersion(), null);
    },
    { throwOnSet: true }
  );
});

test("no window (SSR) reads null and writes nothing", () => {
  const prevWindow = globalThis.window;
  // eslint-disable-next-line no-undefined
  globalThis.window = undefined;
  try {
    assert.equal(readNotifiedUpdateVersion(), null);
    assert.doesNotThrow(() => writeNotifiedUpdateVersion("0.2.0"));
  } finally {
    globalThis.window = prevWindow;
  }
});

// ---------------------------------------------------------------------------
// Center integration - one fixed slot, replaced and removable.
// ---------------------------------------------------------------------------

test("the update entry lives in one fixed center slot and auto-clear removes it", () => {
  withWindow(() => {
    const notice = buildUpdateNotice("0.2.0");
    recordCenterNotifications([
      { id: UPDATE_NOTICE_ID, title: notice.title, body: notice.body, href: notice.href, at: 1000, seen: false }
    ]);
    // A message entry coexists; the update entry replaces only itself.
    recordCenterNotifications([
      { id: "t-1", title: "Davina messaged you", body: "x", href: "/thread/t-1", at: 1100, seen: false }
    ]);
    const superseding = buildUpdateNotice("0.2.1");
    recordCenterNotifications([
      {
        id: UPDATE_NOTICE_ID,
        title: superseding.title,
        body: superseding.body,
        href: superseding.href,
        at: 1200,
        seen: false
      }
    ]);
    let items = readCenterNotifications();
    assert.deepEqual(
      items.map((n) => n.id),
      [UPDATE_NOTICE_ID, "t-1"]
    );
    assert.equal(items[0].title, "Update available v0.2.1");

    // The shell's "clear" plan: up to date removes the reminder, messages stay.
    dismissCenterNotification(UPDATE_NOTICE_ID);
    items = readCenterNotifications();
    assert.deepEqual(
      items.map((n) => n.id),
      ["t-1"]
    );
  });
});
