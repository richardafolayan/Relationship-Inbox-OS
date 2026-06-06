import test from "node:test";
import assert from "node:assert/strict";

// Regression for P3-PL6: subscribeNotificationPermission registers the
// navigator.permissions 'change' listener inside an async `.then`. If the
// caller unmounts (runs the returned cleanup) BEFORE permissions.query
// resolves - e.g. a fast mount/unmount or React Strict Mode's
// mount-unmount-remount - the cleanup ran while permissionStatus was still
// null, so it could not remove the listener. The promise then resolved and
// attached a 'change' listener bound to a now-stale onChange that nothing
// would ever remove. Each such cycle leaked one persistent listener.
const { subscribeNotificationPermission } = await import(
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

// Installs a fake window + Notification + navigator.permissions whose query
// resolves on a controllable deferred, runs `fn`, then restores the globals.
async function withDeferredPermissions(permissionRef, fn) {
  const focusTarget = makeTarget();
  const permStatus = makeTarget();

  let resolveQuery;
  const queryPromise = new Promise((resolve) => {
    resolveQuery = () => resolve(permStatus);
  });

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
  const fakeNavigator = { permissions: { query: () => queryPromise } };

  const prev = {
    window: globalThis.window,
    Notification: globalThis.Notification,
    navigator: globalThis.navigator
  };
  globalThis.window = fakeWindow;
  globalThis.Notification = FakeNotification;
  Object.defineProperty(globalThis, "navigator", {
    value: fakeNavigator,
    configurable: true,
    writable: true
  });

  try {
    await fn({ focusTarget, permStatus, resolveQuery });
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

test("cleanup before permissions.query resolves leaks no 'change' listener", async () => {
  const ref = { value: "default" };
  await withDeferredPermissions(ref, async ({ permStatus, resolveQuery }) => {
    const seen = [];
    const unsubscribe = subscribeNotificationPermission((p) => seen.push(p));

    // Unmount BEFORE the query resolves (the race window).
    unsubscribe();

    // The query now resolves, mimicking the microtask landing after cleanup.
    resolveQuery();
    await Promise.resolve();
    await Promise.resolve();

    // No 'change' listener must remain attached to the resolved status.
    assert.equal(permStatus.count("change"), 0);

    // And a subsequent permission flip must not invoke the stale callback.
    ref.value = "granted";
    permStatus.fire("change");
    assert.deepEqual(seen, []);
  });
});

test("subscribe still attaches and cleans up when query resolves before unmount", async () => {
  const ref = { value: "default" };
  await withDeferredPermissions(ref, async ({ permStatus, resolveQuery }) => {
    const seen = [];
    const unsubscribe = subscribeNotificationPermission((p) => seen.push(p));

    // Query resolves while still mounted: the listener attaches normally.
    resolveQuery();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(permStatus.count("change"), 1);

    ref.value = "granted";
    permStatus.fire("change");
    assert.deepEqual(seen, ["granted"]);

    // Cleanup removes it.
    unsubscribe();
    assert.equal(permStatus.count("change"), 0);
  });
});
