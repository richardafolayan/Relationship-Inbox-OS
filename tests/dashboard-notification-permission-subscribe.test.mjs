import test from "node:test";
import assert from "node:assert/strict";

// Regression for the overdue-digest cadence staying disabled after a same-
// session notification grant. OverdueDigestRow used to read
// Notification.permission once on mount; these helpers let it re-read on a
// live permission change. Pure DOM-stub tests - no React needed.
const { readNotificationPermission, subscribeNotificationPermission } = await import(
  "../apps/dashboard/lib/notifications.ts"
);

// Minimal EventTarget shim: tracks listeners so we can fire and assert removal.
function makeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, cb) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
    fire(type) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

// Installs a fake window + Notification + navigator.permissions, runs `fn`,
// then restores the globals. `permissionRef.value` is the live permission the
// fakes report, so a test can flip it mid-flight like a real grant.
async function withFakeBrowser(permissionRef, fn, { withPermissionsApi = true } = {}) {
  const focusTarget = makeTarget();
  const permStatus = makeTarget();

  class FakeNotification {
    static get permission() {
      return permissionRef.value;
    }
  }

  const fakeWindow = {
    Notification: FakeNotification,
    addEventListener: focusTarget.addEventListener,
    removeEventListener: focusTarget.removeEventListener
  };
  const fakeNavigator = withPermissionsApi
    ? { permissions: { query: () => Promise.resolve(permStatus) } }
    : {};

  const prev = {
    window: globalThis.window,
    Notification: globalThis.Notification,
    navigator: globalThis.navigator
  };
  globalThis.window = fakeWindow;
  globalThis.Notification = FakeNotification;
  // navigator may be a read-only global in some runtimes; define it loosely.
  Object.defineProperty(globalThis, "navigator", {
    value: fakeNavigator,
    configurable: true,
    writable: true
  });

  try {
    await fn({ focusTarget, permStatus });
  } finally {
    globalThis.window = prev.window;
    if (prev.Notification === undefined) delete globalThis.Notification;
    else globalThis.Notification = prev.Notification;
    Object.defineProperty(globalThis, "navigator", {
      value: prev.navigator,
      configurable: true,
      writable: true
    });
  }
}

test("readNotificationPermission reports the live permission", async () => {
  const ref = { value: "default" };
  await withFakeBrowser(ref, () => {
    assert.equal(readNotificationPermission(), "default");
    ref.value = "granted";
    assert.equal(readNotificationPermission(), "granted");
  });
});

test("readNotificationPermission is 'unsupported' without the Notification API", () => {
  const prevWindow = globalThis.window;
  globalThis.window = { focus() {} }; // no Notification key
  try {
    assert.equal(readNotificationPermission(), "unsupported");
  } finally {
    globalThis.window = prevWindow;
  }
});

test("a navigator.permissions 'change' pushes the fresh permission", async () => {
  const ref = { value: "default" };
  await withFakeBrowser(ref, async ({ permStatus }) => {
    const seen = [];
    const unsubscribe = subscribeNotificationPermission((p) => seen.push(p));
    // The change listener is attached after the query promise resolves.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(permStatus.count("change"), 1);

    ref.value = "granted"; // operator grants from the sibling control
    permStatus.fire("change");
    assert.deepEqual(seen, ["granted"]);

    unsubscribe();
    assert.equal(permStatus.count("change"), 0);
  });
});

test("a window 'focus' pushes the fresh permission, and cleanup removes it", async () => {
  const ref = { value: "default" };
  await withFakeBrowser(ref, ({ focusTarget }) => {
    const seen = [];
    const unsubscribe = subscribeNotificationPermission((p) => seen.push(p));
    assert.equal(focusTarget.count("focus"), 1);

    ref.value = "granted";
    focusTarget.fire("focus");
    assert.deepEqual(seen, ["granted"]);

    unsubscribe();
    assert.equal(focusTarget.count("focus"), 0);
  });
});

test("subscribe still works (focus only) when the Permissions API is absent", async () => {
  const ref = { value: "default" };
  await withFakeBrowser(
    ref,
    ({ focusTarget }) => {
      const seen = [];
      const unsubscribe = subscribeNotificationPermission((p) => seen.push(p));
      assert.equal(focusTarget.count("focus"), 1);
      ref.value = "granted";
      focusTarget.fire("focus");
      assert.deepEqual(seen, ["granted"]);
      unsubscribe();
    },
    { withPermissionsApi: false }
  );
});

test("subscribe is a no-op without the Notification API", () => {
  const prevWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} }; // no Notification
  try {
    let called = 0;
    const unsubscribe = subscribeNotificationPermission(() => {
      called += 1;
    });
    assert.equal(typeof unsubscribe, "function");
    unsubscribe(); // must not throw
    assert.equal(called, 0);
  } finally {
    globalThis.window = prevWindow;
  }
});
