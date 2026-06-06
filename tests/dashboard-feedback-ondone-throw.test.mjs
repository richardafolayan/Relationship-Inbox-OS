import test from "node:test";
import assert from "node:assert/strict";

// Regression for P1-L11: in runActionWithFeedback a *successful* action whose
// onDone follow-up (e.g. refresh()) throws used to show the success toast and
// THEN a contradictory error toast (reusing the same id, so it overwrote the
// success), plus flip setError to a failure string. A genuinely-succeeded
// action was reported to the operator as a failure. The fix isolates the
// onDone await so its rejection only logs and never touches the toast/error UI.
const { runActionWithFeedback } = await import("../apps/dashboard/lib/feedback.ts");

// showToast() dispatches an `inbox-toast` CustomEvent on window only when
// `typeof window !== "undefined"`. Stub window.dispatchEvent to record every
// toast's detail so we can assert the kind sequence the operator would see.
function withCapturedToasts(run) {
  const prevWindow = globalThis.window;
  const prevWarn = console.warn;
  const toasts = [];
  const warnings = [];
  globalThis.window = {
    dispatchEvent(event) {
      toasts.push(event.detail);
      return true;
    }
  };
  console.warn = (...args) => {
    warnings.push(args);
  };
  return Promise.resolve()
    .then(() => run({ toasts, warnings }))
    .finally(() => {
      globalThis.window = prevWindow;
      console.warn = prevWarn;
    });
}

// runActionWithFeedback is fire-and-forget (returns void). Flush the microtask
// queue enough times for the resolved promise -> .then -> awaited onDone chain
// to settle deterministically.
async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("a throwing onDone on a SUCCEEDED action does not show an error toast or set an error", async () => {
  await withCapturedToasts(async ({ toasts, warnings }) => {
    let lastError = "unset";
    runActionWithFeedback(Promise.resolve("ok"), {
      pending: "Working...",
      success: "Done",
      failure: "Failed",
      setError: (message) => {
        lastError = message;
      },
      // The hazardous follow-up: a refresh() that rejects after a real success.
      onDone: () => {
        throw new Error("refresh blew up");
      }
    });

    await settle();

    const kinds = toasts.map((t) => t.kind);
    // Operator sees exactly the optimistic spinner replaced by success - no
    // contradictory error toast tacked on afterwards.
    assert.deepEqual(kinds, ["pending", "success"]);
    // The action genuinely succeeded, so the error state must be cleared, not
    // flipped to the failure message.
    assert.equal(lastError, null);
    // The onDone failure is still surfaced to DevTools, just not to the user.
    assert.equal(warnings.length, 1);
  });
});

test("a genuinely failing action still shows the error toast and sets the error", async () => {
  await withCapturedToasts(async ({ toasts }) => {
    let lastError = "unset";
    runActionWithFeedback(Promise.reject(new Error("network down")), {
      pending: "Working...",
      success: "Done",
      failure: "Failed",
      setError: (message) => {
        lastError = message;
      }
    });

    await settle();

    const kinds = toasts.map((t) => t.kind);
    assert.deepEqual(kinds, ["pending", "error"]);
    assert.equal(lastError, "network down");
  });
});
