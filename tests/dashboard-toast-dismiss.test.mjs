import test from "node:test";
import assert from "node:assert/strict";

// #758: dismissToast(id) is the programmatic removal path for toasts made
// moot by app state (thread replied). Event contract only - the ToastHost
// wires onToastDismiss to its internal dismiss().
const { dismissToast, onToastDismiss } = await import("../apps/dashboard/lib/feedback.ts");

function withWindow(run) {
  const listeners = new Map();
  const win = {
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    }
  };
  const prevWindow = globalThis.window;
  const prevCustomEvent = globalThis.CustomEvent;
  globalThis.window = win;
  if (typeof globalThis.CustomEvent === "undefined") {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
  try {
    return run();
  } finally {
    globalThis.window = prevWindow;
    globalThis.CustomEvent = prevCustomEvent;
  }
}

test("dismissToast reaches subscribers with the toast id", () => {
  withWindow(() => {
    const seen = [];
    const off = onToastDismiss((id) => seen.push(id));
    dismissToast("new-message:t-1");
    dismissToast("new-message:t-2");
    off();
    dismissToast("new-message:t-3");
    assert.deepEqual(seen, ["new-message:t-1", "new-message:t-2"]);
  });
});

test("dismissToast without a window is a safe no-op", () => {
  const prevWindow = globalThis.window;
  // eslint-disable-next-line no-undefined
  globalThis.window = undefined;
  try {
    assert.doesNotThrow(() => dismissToast("new-message:t-1"));
    assert.doesNotThrow(() => onToastDismiss(() => {})());
  } finally {
    globalThis.window = prevWindow;
  }
});
