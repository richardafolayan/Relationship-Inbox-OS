import test from "node:test";
import assert from "node:assert/strict";

// Pure helpers behind the new-message notification UX (#440). These build
// the title/body/route for a notice and decide where it surfaces, so they
// are unit-testable without a DOM or the Notification API.
const {
  buildNewMessageNotice,
  buildNewMessageDigestNotice,
  planNewMessageNotice,
  shouldShowNotificationCta,
  notifyNewMessage,
  notifyNewMessageDigest
} = await import("../apps/dashboard/lib/notifications.ts");

// Minimal InboxRow stand-in: the builders only read these fields.
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

test("buildNewMessageNotice: title names the person and href opens the thread", () => {
  const notice = buildNewMessageNotice(row());
  assert.equal(notice.title, "Davina messaged you");
  assert.equal(notice.body, "Wants to confirm Friday's call.");
  assert.equal(notice.href, "/thread/t-1");
});

test("buildNewMessageNotice: body falls back to preview, then a calm default", () => {
  const fromPreview = buildNewMessageNotice(
    row({ whatTheyWant: "  ", preview: "Quick question about the deck" })
  );
  assert.equal(fromPreview.body, "Quick question about the deck");

  const fallback = buildNewMessageNotice(
    row({ whatTheyWant: null, preview: "No summary yet" })
  );
  assert.equal(fallback.body, "Open the conversation to catch up.");
});

test("buildNewMessageDigestNotice: roll-up names the first person and counts the rest", () => {
  const two = buildNewMessageDigestNotice([
    row({ id: "t-1", personName: "Davina" }),
    row({ id: "t-2", personName: "Joseph" })
  ]);
  assert.equal(two.title, "2 new messages");
  assert.equal(two.body, "Davina and 1 other are waiting on a reply.");
  assert.equal(two.href, "/today");

  const four = buildNewMessageDigestNotice([
    row({ id: "t-1", personName: "Davina" }),
    row({ id: "t-2", personName: "Joseph" }),
    row({ id: "t-3", personName: "Ayo" }),
    row({ id: "t-4", personName: "Sam" })
  ]);
  assert.equal(four.title, "4 new messages");
  assert.equal(four.body, "Davina and 3 others are waiting on a reply.");
  assert.equal(four.href, "/today");
});

test("planNewMessageNotice: nothing fresh surfaces nothing", () => {
  assert.equal(
    planNewMessageNotice({ freshCount: 0, tabHidden: true, quietHoursActive: false }),
    "none"
  );
  assert.equal(
    planNewMessageNotice({ freshCount: 0, tabHidden: false, quietHoursActive: false }),
    "none"
  );
});

test("planNewMessageNotice: hidden tab uses desktop notifications, rolled up past 3", () => {
  const hidden = (freshCount) =>
    planNewMessageNotice({ freshCount, tabHidden: true, quietHoursActive: false });
  assert.equal(hidden(1), "desktop-single");
  assert.equal(hidden(3), "desktop-single");
  assert.equal(hidden(4), "desktop-digest");
});

test("planNewMessageNotice: quiet hours silences the desktop ping only", () => {
  assert.equal(
    planNewMessageNotice({ freshCount: 2, tabHidden: true, quietHoursActive: true }),
    "none"
  );
  // Focused tab is unaffected by quiet hours: a toast is only ever seen
  // when the operator is already looking at the app.
  assert.equal(
    planNewMessageNotice({ freshCount: 2, tabHidden: false, quietHoursActive: true }),
    "toast-single"
  );
});

test("planNewMessageNotice: focused tab uses in-app toasts, rolled up past 3", () => {
  const focused = (freshCount) =>
    planNewMessageNotice({ freshCount, tabHidden: false, quietHoursActive: false });
  assert.equal(focused(1), "toast-single");
  assert.equal(focused(3), "toast-single");
  assert.equal(focused(4), "toast-digest");
});

test("shouldShowNotificationCta: only when supported, undecided, and not dismissed", () => {
  assert.equal(
    shouldShowNotificationCta({ supported: true, permission: "default", dismissed: false }),
    true
  );
  // Already decided either way: never re-ask.
  assert.equal(
    shouldShowNotificationCta({ supported: true, permission: "granted", dismissed: false }),
    false
  );
  assert.equal(
    shouldShowNotificationCta({ supported: true, permission: "denied", dismissed: false }),
    false
  );
  // Dismissed by the operator, or no browser support: stay hidden.
  assert.equal(
    shouldShowNotificationCta({ supported: true, permission: "default", dismissed: true }),
    false
  );
  assert.equal(
    shouldShowNotificationCta({ supported: false, permission: "unsupported", dismissed: false }),
    false
  );
});

// Desktop-notification path (tab hidden). Mirrors the Notification-API shim
// used in dashboard-overdue-digest.test.mjs: notifications.ts inspects
// `"Notification" in window` and reads `Notification.permission` off the
// global, and `show()` calls `new Notification(...)` then `window.focus()`
// from the click handler. Stub both so we can assert what gets constructed.
function withGrantedNotification(run) {
  const instances = [];
  let focused = 0;
  class FakeNotification {
    constructor(title, init) {
      this.title = title;
      this.init = init || {};
      this.onclick = null;
      instances.push(this);
    }
    close() {
      this.closed = true;
    }
    static permission = "granted";
    static requestPermission() {
      return Promise.resolve("granted");
    }
  }
  const prevWindow = globalThis.window;
  const prevNotification = globalThis.Notification;
  globalThis.window = { Notification: FakeNotification, focus: () => { focused += 1; } };
  globalThis.Notification = FakeNotification;
  try {
    return run({ instances, getFocused: () => focused });
  } finally {
    globalThis.window = prevWindow;
    if (prevNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = prevNotification;
  }
}

test("notifyNewMessage builds one desktop notification keyed to the thread; click focuses + opens it", () => {
  withGrantedNotification(({ instances, getFocused }) => {
    let openedId = null;
    notifyNewMessage(row(), (id) => {
      openedId = id;
    });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].title, "Davina messaged you");
    assert.equal(instances[0].init.body, "Wants to confirm Friday's call.");
    assert.equal(instances[0].init.tag, "inbox-os:thread:t-1");
    // Not opened until the operator actually clicks the notification.
    assert.equal(openedId, null);
    instances[0].onclick();
    assert.equal(openedId, "t-1");
    assert.equal(getFocused(), 1);
  });
});

test("notifyNewMessageDigest builds one roll-up desktop notification", () => {
  withGrantedNotification(({ instances }) => {
    notifyNewMessageDigest(
      [row({ id: "t-1", personName: "Davina" }), row({ id: "t-2", personName: "Joseph" })],
      () => {}
    );
    assert.equal(instances.length, 1);
    assert.equal(instances[0].title, "2 new messages");
    assert.equal(instances[0].init.tag, "inbox-os:digest");
  });
});

test("desktop notifications are not constructed when permission is not granted", () => {
  const prevWindow = globalThis.window;
  const prevNotification = globalThis.Notification;
  const constructed = [];
  class DeniedNotification {
    constructor(title, init) {
      constructed.push({ title, init });
    }
    static permission = "denied";
  }
  globalThis.window = { Notification: DeniedNotification, focus() {} };
  globalThis.Notification = DeniedNotification;
  try {
    notifyNewMessage(row(), () => {});
    notifyNewMessageDigest([row()], () => {});
    assert.equal(constructed.length, 0);
  } finally {
    globalThis.window = prevWindow;
    if (prevNotification === undefined) delete globalThis.Notification;
    else globalThis.Notification = prevNotification;
  }
});
