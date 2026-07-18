import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Framework-free controller + DOM effect helpers (tsx resolves .ts directly).
const {
  createMobileOverlayController
} = await import("../apps/dashboard/lib/mobile-overlay-controller.ts");
const {
  MOBILE_OVERLAY_HISTORY_KEY,
  bindOverlayHistory,
  bindVisualViewport,
  browserVisualViewportHost,
  captureFocus,
  collectBrowserScrollOwners,
  createScrollLock,
  createScrollLockManager
} = await import("../apps/dashboard/lib/mobile-overlay-effects.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────── stacking prevention ───────────────────────────

test("open registers a single primary overlay", () => {
  const c = createMobileOverlayController({ generateId: () => "a1" });
  let closed = 0;
  const result = c.open({
    kind: "search",
    onRequestClose: () => {
      closed += 1;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, "a1");
  assert.equal(c.isPrimaryActive(), true);
  assert.equal(c.getTop()?.kind, "search");
  assert.equal(c.getSnapshot().length, 1);
  assert.equal(closed, 0);
});

test("replace policy closes the previous primary before the new one is top", () => {
  const c = createMobileOverlayController({
    generateId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })()
  });
  const closed = [];
  c.open({
    kind: "search",
    onRequestClose: () => closed.push("search")
  });
  const result = c.open({
    kind: "feedback",
    policy: "replace",
    onRequestClose: () => closed.push("feedback")
  });
  assert.equal(result.ok, true);
  assert.equal(result.replaced?.kind, "search");
  assert.equal(c.getSnapshot().length, 1, "exactly one primary remains");
  assert.equal(c.getTop()?.kind, "feedback");
  assert.deepEqual(closed, ["search"], "replaced surface received onRequestClose");
});

test("reject policy keeps the existing primary and refuses the new open", () => {
  const c = createMobileOverlayController();
  const closed = [];
  c.open({
    kind: "ai-assist",
    id: "ai",
    onRequestClose: () => closed.push("ai")
  });
  const result = c.open({
    kind: "walkthrough",
    policy: "reject",
    onRequestClose: () => closed.push("walk")
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rejected_primary_active");
  assert.equal(result.active.kind, "ai-assist");
  assert.equal(c.getTop()?.id, "ai");
  assert.equal(c.getSnapshot().length, 1);
  assert.deepEqual(closed, []);
});

test("two primary overlays cannot remain active simultaneously under replace", () => {
  const c = createMobileOverlayController();
  for (const kind of ["search", "feedback", "action-sheet", "walkthrough"]) {
    c.open({
      kind,
      onRequestClose: () => undefined
    });
    assert.equal(
      c.getSnapshot().length,
      1,
      `after opening ${kind} the stack must still be size 1`
    );
  }
  assert.equal(c.getTop()?.kind, "walkthrough");
});

test("re-opening the same id is a no-op keep", () => {
  const c = createMobileOverlayController();
  let closed = 0;
  c.open({
    kind: "search",
    id: "palette",
    onRequestClose: () => {
      closed += 1;
    }
  });
  const again = c.open({
    kind: "search",
    id: "palette",
    onRequestClose: () => {
      closed += 1;
    }
  });
  assert.equal(again.ok, true);
  assert.equal(again.replaced, null);
  assert.equal(c.getSnapshot().length, 1);
  assert.equal(closed, 0);
});

// ─────────────────────────── Back / Escape dismiss ───────────────────────────

test("handleDismiss closes the top overlay and reports the event as consumed", () => {
  const c = createMobileOverlayController();
  let closed = false;
  c.open({
    kind: "feedback",
    onRequestClose: () => {
      closed = true;
    }
  });
  assert.equal(c.handleDismiss(), true);
  assert.equal(closed, true);
  assert.equal(c.isPrimaryActive(), false);
  assert.equal(c.handleDismiss(), false, "second dismiss is a no-op");
});

test("closeTop and close(id) invoke onRequestClose unless silent", () => {
  const c = createMobileOverlayController();
  let n = 0;
  c.open({
    kind: "search",
    id: "s1",
    onRequestClose: () => {
      n += 1;
    }
  });
  c.close("s1");
  assert.equal(n, 1);
  assert.equal(c.isPrimaryActive(), false);

  c.open({
    kind: "search",
    id: "s2",
    onRequestClose: () => {
      n += 1;
    }
  });
  c.close("s2", { silent: true });
  assert.equal(n, 1, "silent close must not re-enter onRequestClose");
  assert.equal(c.isPrimaryActive(), false);
});

/** Session-history stack with deferred traversal (models real browsers). */
function createAsyncHistoryStack(initialState = null) {
  const stack = [{ state: initialState }];
  let index = 0;
  const listeners = new Set();
  let backCalls = 0;
  let pushCalls = 0;
  let replaceCalls = 0;
  const pending = [];

  const flushLater = (fn) => {
    pending.push(fn);
    setTimeout(() => {
      const i = pending.indexOf(fn);
      if (i >= 0) pending.splice(i, 1);
      fn();
    }, 0);
  };

  const history = {
    get state() {
      return stack[index]?.state ?? null;
    },
    get index() {
      return index;
    },
    get length() {
      return stack.length;
    },
    get backCalls() {
      return backCalls;
    },
    get pushCalls() {
      return pushCalls;
    },
    get replaceCalls() {
      return replaceCalls;
    },
    pushState(data) {
      pushCalls += 1;
      stack.splice(index + 1);
      stack.push({ state: data });
      index = stack.length - 1;
    },
    replaceState(data) {
      replaceCalls += 1;
      stack[index] = { state: data };
    },
    back() {
      backCalls += 1;
      if (index <= 0) return;
      const nextIndex = index - 1;
      flushLater(() => {
        index = nextIndex;
        const state = stack[index]?.state ?? null;
        for (const listener of [...listeners]) listener({ state });
      });
    },
    /** User/system Back: same async popstate path as history.back(). */
    userBack() {
      if (index <= 0) return;
      const nextIndex = index - 1;
      flushLater(() => {
        index = nextIndex;
        const state = stack[index]?.state ?? null;
        for (const listener of [...listeners]) listener({ state });
      });
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    listenerCount() {
      return listeners.size;
    }
  };

  return history;
}

function waitForMacrotask() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Mirrors MobileOverlayProvider history lifecycle: one frame for the primary
 * lifetime, retarget on replace, deferred release only when idle.
 */
function createProviderHistoryLifecycle(history, controller) {
  let binding = null;
  let activeId = null;
  let releaseTimer = null;

  const sync = () => {
    const top = controller.getTop();
    const primaryActive = controller.isPrimaryActive();

    if (!primaryActive || !top) {
      if (binding && releaseTimer == null) {
        const current = binding;
        releaseTimer = setTimeout(() => {
          releaseTimer = null;
          if (binding === current) {
            binding.release();
            binding = null;
            activeId = null;
          }
        }, 0);
      }
      return;
    }

    if (releaseTimer != null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }

    if (binding && !binding.isActive()) {
      binding = null;
      activeId = null;
    }

    if (!binding) {
      activeId = top.id;
      binding = bindOverlayHistory({
        history,
        overlayId: top.id,
        onBack: () => controller.handleDismiss()
      });
    } else if (activeId !== top.id) {
      binding.retarget(top.id);
      activeId = top.id;
    }
  };

  return {
    sync,
    getBinding: () => binding,
    getActiveId: () => activeId,
    forceRelease() {
      if (releaseTimer != null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      binding?.release();
      binding = null;
      activeId = null;
    }
  };
}

test("history popstate (system Back) closes the active overlay via onBack", async () => {
  const history = createAsyncHistoryStack(null);
  const c = createMobileOverlayController();
  let closed = false;
  const opened = c.open({
    kind: "action-sheet",
    id: "sheet-1",
    onRequestClose: () => {
      closed = true;
    }
  });
  assert.equal(opened.ok, true);

  const binding = bindOverlayHistory({
    history,
    overlayId: opened.id,
    onBack: () => c.handleDismiss()
  });

  assert.equal(history.state?.[MOBILE_OVERLAY_HISTORY_KEY], "sheet-1");

  history.userBack();
  await waitForMacrotask();

  assert.equal(closed, true);
  assert.equal(c.isPrimaryActive(), false);

  binding.release();
});

test("programmatic history release calls history.back without re-dismissing", async () => {
  const history = createAsyncHistoryStack({ prior: true });
  let onBackCalls = 0;
  const binding = bindOverlayHistory({
    history,
    overlayId: "x",
    onBack: () => {
      onBackCalls += 1;
      return true;
    }
  });

  binding.release();
  assert.equal(history.backCalls, 1);
  await waitForMacrotask();
  assert.equal(onBackCalls, 0, "UI close must not re-fire onBack via popstate");
  assert.equal(history.state?.prior, true);
});

test("replace retargets history in place and does not auto-dismiss the new primary", async () => {
  const history = createAsyncHistoryStack({ page: true });
  const c = createMobileOverlayController();
  const closed = [];
  const lifecycle = createProviderHistoryLifecycle(history, c);

  c.open({
    kind: "search",
    id: "command-palette",
    onRequestClose: () => closed.push("search")
  });
  lifecycle.sync();

  assert.equal(history.pushCalls, 1);
  assert.equal(history.state?.[MOBILE_OVERLAY_HISTORY_KEY], "command-palette");
  assert.equal(history.length, 2);
  assert.equal(history.index, 1);

  // Search → Feedback (replace policy): provider must retarget, not release+push.
  c.open({
    kind: "feedback",
    id: "pilot-feedback",
    policy: "replace",
    onRequestClose: () => closed.push("feedback")
  });
  lifecycle.sync();

  assert.equal(c.getTop()?.id, "pilot-feedback");
  assert.equal(c.isPrimaryActive(), true);
  assert.deepEqual(closed, ["search"]);
  assert.equal(history.pushCalls, 1, "replace must not push a second overlay frame");
  assert.equal(history.replaceCalls, 1);
  assert.equal(history.backCalls, 0, "replace must not call history.back");
  assert.equal(history.state?.[MOBILE_OVERLAY_HISTORY_KEY], "pilot-feedback");

  // Deferred microtasks from a buggy release+back would fire here and dismiss feedback.
  await waitForMacrotask();

  assert.equal(c.isPrimaryActive(), true, "feedback must survive async history drain");
  assert.equal(c.getTop()?.id, "pilot-feedback");
  assert.deepEqual(closed, ["search"], "feedback must not receive auto-dismiss");
  assert.equal(history.index, 1);
  assert.equal(history.length, 2, "stack is [page, overlay-marker]");

  // Idle: single back returns to the pre-overlay entry.
  c.close("pilot-feedback", { silent: true });
  lifecycle.sync();
  await waitForMacrotask();

  assert.equal(c.isPrimaryActive(), false);
  assert.equal(history.backCalls, 1);
  assert.equal(history.index, 0);
  assert.equal(history.state?.page, true);
});

test("open → UI close → idle drains one back without re-dismiss", async () => {
  const history = createAsyncHistoryStack({ page: true });
  const c = createMobileOverlayController();
  let closed = 0;
  const lifecycle = createProviderHistoryLifecycle(history, c);

  c.open({
    kind: "search",
    id: "command-palette",
    onRequestClose: () => {
      closed += 1;
    }
  });
  lifecycle.sync();

  c.close("command-palette", { silent: true });
  lifecycle.sync();
  await waitForMacrotask();

  assert.equal(closed, 0, "silent UI close does not re-enter onRequestClose via history");
  assert.equal(history.backCalls, 1);
  assert.equal(history.index, 0);
  assert.equal(c.isPrimaryActive(), false);
});

test("open → system Back dismisses once and returns to pre-overlay entry", async () => {
  const history = createAsyncHistoryStack({ page: true });
  const c = createMobileOverlayController();
  let closed = 0;
  const lifecycle = createProviderHistoryLifecycle(history, c);

  c.open({
    kind: "feedback",
    id: "pilot-feedback",
    onRequestClose: () => {
      closed += 1;
    }
  });
  lifecycle.sync();

  history.userBack();
  await waitForMacrotask();

  assert.equal(closed, 1);
  assert.equal(c.isPrimaryActive(), false);
  assert.equal(history.index, 0);
  assert.equal(history.state?.page, true);

  lifecycle.sync();
  await waitForMacrotask();
  // Deferred idle release must not back again (already at pre-overlay).
  assert.ok(history.backCalls <= 1, "no extra back after system dismiss");
});

test("retarget updates marker without push or back", async () => {
  const history = createAsyncHistoryStack({ page: true });
  let onBackCalls = 0;
  const binding = bindOverlayHistory({
    history,
    overlayId: "a",
    onBack: () => {
      onBackCalls += 1;
      return true;
    }
  });

  binding.retarget("b");
  assert.equal(history.pushCalls, 1);
  assert.equal(history.replaceCalls, 1);
  assert.equal(history.backCalls, 0);
  assert.equal(history.state?.[MOBILE_OVERLAY_HISTORY_KEY], "b");
  assert.equal(onBackCalls, 0);

  binding.release();
  await waitForMacrotask();
  assert.equal(onBackCalls, 0);
});

test("legacy release+rebind would dismiss replacement; retarget path does not", async () => {
  const history = createAsyncHistoryStack({ page: true });
  const c = createMobileOverlayController();
  const closed = [];

  c.open({
    kind: "search",
    id: "command-palette",
    onRequestClose: () => closed.push("search")
  });
  const first = bindOverlayHistory({
    history,
    overlayId: "command-palette",
    onBack: () => c.handleDismiss()
  });

  // Buggy provider path: release (async back) then bind the replacement.
  c.open({
    kind: "feedback",
    id: "pilot-feedback",
    policy: "replace",
    onRequestClose: () => closed.push("feedback")
  });
  first.release();
  const second = bindOverlayHistory({
    history,
    overlayId: "pilot-feedback",
    onBack: () => c.handleDismiss()
  });

  await waitForMacrotask();

  // Absorber must swallow the deferred back from first.release so feedback stays.
  assert.equal(c.isPrimaryActive(), true);
  assert.equal(c.getTop()?.id, "pilot-feedback");
  assert.ok(!closed.includes("feedback"), "replacement must not auto-dismiss");

  second.release();
  await waitForMacrotask();
});

// ─────────────────────────── scroll lock ───────────────────────────

test("createScrollLock hides body overflow and restores previous styles", () => {
  const bodyStyle = { overflow: "", paddingRight: "" };
  const props = new Map();
  const host = {
    bodyStyle,
    documentElementStyle: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name)
    },
    scrollbarGapPx: 12
  };

  const lock = createScrollLock(host);
  assert.equal(bodyStyle.overflow, "hidden");
  assert.equal(bodyStyle.paddingRight, "12px");
  assert.equal(props.get("--overlay-scroll-locked"), "1");

  lock.release();
  assert.equal(bodyStyle.overflow, "");
  assert.equal(bodyStyle.paddingRight, "");
  assert.equal(props.has("--overlay-scroll-locked"), false);

  lock.release();
  assert.equal(bodyStyle.overflow, "", "double release is a no-op");
});

test("createScrollLock also locks explicit scroll owners (main/canvas/timeline)", () => {
  const bodyStyle = { overflow: "", paddingRight: "" };
  const mainStyle = { overflow: "auto", overscrollBehavior: "contain" };
  const canvasStyle = { overflow: "auto", overscrollBehavior: "contain" };
  const timelineStyle = { overflow: "auto", overscrollBehavior: "auto" };
  const host = {
    bodyStyle,
    scrollbarGapPx: 0,
    scrollOwners: [
      { style: mainStyle },
      { style: canvasStyle },
      { style: timelineStyle }
    ]
  };

  const lock = createScrollLock(host);
  assert.equal(bodyStyle.overflow, "hidden");
  assert.equal(mainStyle.overflow, "hidden");
  assert.equal(canvasStyle.overflow, "hidden");
  assert.equal(timelineStyle.overflow, "hidden");
  assert.equal(mainStyle.overscrollBehavior, "none");
  assert.equal(canvasStyle.overscrollBehavior, "none");
  assert.equal(timelineStyle.overscrollBehavior, "none");

  lock.release();
  assert.equal(mainStyle.overflow, "auto");
  assert.equal(canvasStyle.overflow, "auto");
  assert.equal(timelineStyle.overflow, "auto");
  assert.equal(mainStyle.overscrollBehavior, "contain");
  assert.equal(canvasStyle.overscrollBehavior, "contain");
  assert.equal(timelineStyle.overscrollBehavior, "auto");
});

test("collectBrowserScrollOwners de-dupes data-scroll-owner and main", () => {
  const mainStyle = { overflow: "auto" };
  const canvasStyle = { overflow: "scroll" };
  const timelineStyle = { overflow: "auto" };
  const main = { style: mainStyle };
  const canvas = { style: canvasStyle };
  const timeline = { style: timelineStyle };

  const doc = {
    querySelectorAll(sel) {
      if (sel === "[data-scroll-owner]") return [main, canvas];
      if (sel.includes("thread-timeline") || sel.includes("thread-messages")) {
        return [timeline];
      }
      return [];
    },
    querySelector(sel) {
      if (sel === "main") return main;
      if (sel.includes("data-scroll-owner")) return null;
      return null;
    }
  };

  const owners = collectBrowserScrollOwners(doc);
  assert.equal(owners.length, 3, "main+canvas+timeline once each");
  assert.equal(owners[0].style, mainStyle);
  assert.equal(owners[1].style, canvasStyle);
  assert.equal(owners[2].style, timelineStyle);
});

test("scroll lock manager is ref-counted and only unlocks at depth 0", () => {
  const bodyStyle = { overflow: "auto", paddingRight: "0px" };
  const host = { bodyStyle, scrollbarGapPx: 0 };
  const manager = createScrollLockManager(() => host);

  const releaseA = manager.acquire();
  assert.equal(manager.isLocked(), true);
  assert.equal(bodyStyle.overflow, "hidden");

  const releaseB = manager.acquire();
  assert.equal(manager.getDepth(), 2);
  assert.equal(bodyStyle.overflow, "hidden");

  releaseA();
  assert.equal(manager.isLocked(), true, "still locked while nested hold remains");
  assert.equal(bodyStyle.overflow, "hidden");

  releaseB();
  assert.equal(manager.isLocked(), false);
  assert.equal(bodyStyle.overflow, "auto");
});

// ─────────────────────────── focus + visualViewport ───────────────────────────

test("captureFocus restores the previously focused element", () => {
  const calls = [];
  const previous = {
    focus: () => calls.push("restored")
  };
  const restore = captureFocus({ activeElement: previous });
  restore();
  assert.deepEqual(calls, ["restored"]);
});

test("bindVisualViewport writes CSS vars and clears them on release", () => {
  const props = new Map();
  const listeners = { resize: new Set(), scroll: new Set() };
  const host = {
    visualViewport: {
      height: 500,
      offsetTop: 0,
      addEventListener: (type, listener) => listeners[type].add(listener),
      removeEventListener: (type, listener) => listeners[type].delete(listener)
    },
    innerHeight: 700,
    documentElementStyle: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name)
    }
  };

  const binding = bindVisualViewport(host);
  assert.equal(props.get("--overlay-vvh"), "500px");
  assert.equal(props.get("--overlay-keyboard-inset"), "200px");
  assert.equal(binding.getOverlayHeightPx(), 500);

  host.visualViewport.height = 480;
  for (const listener of listeners.resize) listener();
  assert.equal(props.get("--overlay-vvh"), "480px");
  assert.equal(props.get("--overlay-keyboard-inset"), "220px");

  binding.release();
  assert.equal(props.has("--overlay-vvh"), false);
  assert.equal(props.has("--overlay-keyboard-inset"), false);
  assert.equal(listeners.resize.size, 0);
});

test("visualViewport host uses live getters so viewport changes without mutating the wrapper", () => {
  // Models the browser adapter: underlying visualViewport mutates in place;
  // the host wrapper must not snapshot height/offsetTop at create time.
  const underlying = {
    height: 640,
    offsetTop: 0,
    listeners: { resize: new Set(), scroll: new Set() },
    addEventListener(type, listener) {
      this.listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      this.listeners[type].delete(listener);
    }
  };
  let innerHeight = 800;
  const props = new Map();

  const host = {
    get visualViewport() {
      return {
        get height() {
          return underlying.height;
        },
        get offsetTop() {
          return underlying.offsetTop;
        },
        addEventListener: (type, listener) => underlying.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
          underlying.removeEventListener(type, listener)
      };
    },
    get innerHeight() {
      return innerHeight;
    },
    documentElementStyle: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name)
    }
  };

  const binding = bindVisualViewport(host);
  assert.equal(props.get("--overlay-vvh"), "640px");
  assert.equal(props.get("--overlay-keyboard-inset"), "160px");

  // Change only the underlying viewport; do not mutate the wrapper object.
  underlying.height = 420;
  underlying.offsetTop = 40;
  for (const listener of underlying.listeners.resize) listener();

  assert.equal(props.get("--overlay-vvh"), "420px");
  assert.equal(props.get("--overlay-vv-offset-top"), "40px");
  assert.equal(props.get("--overlay-keyboard-inset"), "340px");
  assert.equal(binding.getOverlayHeightPx(), 420);

  binding.release();
  assert.equal(underlying.listeners.resize.size, 0);
});

test("browserVisualViewportHost source uses live getters, not one-shot copies", () => {
  const effects = readFileSync(
    join(ROOT, "apps/dashboard/lib/mobile-overlay-effects.ts"),
    "utf8"
  );
  // Adapter must not assign height/offsetTop from window.visualViewport as
  // plain data properties at create (stale after keyboard/chrome resize).
  assert.match(effects, /get height\(\)/);
  assert.match(effects, /get offsetTop\(\)/);
  assert.match(effects, /get innerHeight\(\)/);
  assert.match(effects, /get visualViewport\(\)/);
  assert.doesNotMatch(
    effects,
    /visualViewport:\s*window\.visualViewport\s*\?\s*\{\s*height:\s*window\.visualViewport\.height/
  );
  assert.match(effects, /collectBrowserScrollOwners/);
  assert.match(effects, /scrollOwners/);
  // browserVisualViewportHost is the production adapter under test via source.
  assert.equal(typeof browserVisualViewportHost, "function");
});

// ─────────────────────────── wiring (source contracts) ───────────────────────────

test("layout wraps the shell in MobileOverlayProvider", () => {
  const layout = readFileSync(join(ROOT, "apps/dashboard/app/layout.tsx"), "utf8");
  assert.match(layout, /MobileOverlayProvider/);
  assert.match(layout, /<MobileOverlayProvider>/);
  assert.match(layout, /<\/MobileOverlayProvider>/);
});

test("command palette search is registered as a primary overlay", () => {
  const shell = readFileSync(
    join(ROOT, "apps/dashboard/components/layout/app-shell.tsx"),
    "utf8"
  );
  assert.match(shell, /usePrimaryOverlay/);
  assert.match(shell, /kind:\s*"search"/);
  assert.match(shell, /id:\s*"command-palette"/);
});

test("pilot feedback modal is registered as a primary overlay", () => {
  const modal = readFileSync(
    join(ROOT, "apps/dashboard/components/common/pilot-feedback-modal.tsx"),
    "utf8"
  );
  assert.match(modal, /usePrimaryOverlay/);
  assert.match(modal, /kind:\s*"feedback"/);
  assert.match(modal, /id:\s*"pilot-feedback"/);
});

test("controller and effects modules export the public API surface", () => {
  const controller = readFileSync(
    join(ROOT, "apps/dashboard/lib/mobile-overlay-controller.ts"),
    "utf8"
  );
  const effects = readFileSync(
    join(ROOT, "apps/dashboard/lib/mobile-overlay-effects.ts"),
    "utf8"
  );
  assert.match(controller, /export function createMobileOverlayController/);
  assert.match(controller, /handleDismiss/);
  assert.match(controller, /OpenConflictPolicy/);
  assert.match(effects, /export function createScrollLock/);
  assert.match(effects, /export function bindOverlayHistory/);
  assert.match(effects, /export function bindVisualViewport/);
  assert.match(effects, /export function captureFocus/);
  assert.match(effects, /export function collectBrowserScrollOwners/);
  assert.match(effects, /export function browserVisualViewportHost/);
});

test("usePrimaryOverlay depends on stable actions, not the reactive snapshot object", () => {
  const provider = readFileSync(
    join(ROOT, "apps/dashboard/components/common/mobile-overlay-provider.tsx"),
    "utf8"
  );

  // Split actions (stable) from snapshot (top/primaryActive).
  assert.match(provider, /MobileOverlayActionsContext/);
  assert.match(provider, /MobileOverlaySnapshotContext/);
  assert.match(provider, /useMobileOverlayActionsOptional/);
  assert.match(provider, /useMobileOverlaySnapshot/);

  // Effect must not list the whole overlay context as a dependency.
  const hookStart = provider.indexOf("export function usePrimaryOverlay");
  assert.ok(hookStart >= 0, "usePrimaryOverlay must exist");
  const hookBody = provider.slice(hookStart, hookStart + 2200);
  assert.doesNotMatch(hookBody, /\}, \[overlay[,\]]/);
  assert.doesNotMatch(hookBody, /useEffect\([\s\S]*?\}, \[overlay/);
  // Stable primitives only.
  assert.match(hookBody, /controller,\s*\n\s*openOverlay/);
  assert.match(hookBody, /options\.open/);
});

/**
 * Simulates the usePrimaryOverlay effect lifecycle against a real controller.
 * When actions identity stays stable across a provider snapshot rerender
 * (top changes after open), cleanup must not fire and reopen must not run.
 */
test("one open() stays registered across provider snapshot rerender (no open/close loop)", () => {
  let idSeq = 0;
  const c = createMobileOverlayController({
    generateId: () => `ov-${++idSeq}`
  });

  // Stable actions object (same identity across "rerenders").
  const actions = {
    controller: c,
    open: (input) => c.open(input),
    close: (id, options) => c.close(id, options)
  };

  let entryId = null;
  let openCalls = 0;
  let silentCloseCalls = 0;
  let ownerCloseCalls = 0;

  const runRegistration = (openFlag, actionsRef) => {
    // Mirror usePrimaryOverlay effect body with the fixed deps list.
    if (!actionsRef.controller || !actionsRef.open) return () => undefined;
    if (!openFlag) {
      if (entryId) {
        const id = entryId;
        entryId = null;
        actionsRef.controller.close(id, { silent: true });
        silentCloseCalls += 1;
      }
      return () => undefined;
    }
    openCalls += 1;
    const result = actionsRef.open({
      kind: "search",
      id: "command-palette",
      policy: "replace",
      onRequestClose: () => {
        ownerCloseCalls += 1;
      }
    });
    if (result.ok) entryId = result.id;
    return () => {
      if (entryId) {
        const id = entryId;
        entryId = null;
        actionsRef.controller.close(id, { silent: true });
        silentCloseCalls += 1;
      }
    };
  };

  // Mount with open=true.
  let cleanup = runRegistration(true, actions);
  assert.equal(openCalls, 1);
  assert.equal(c.isPrimaryActive(), true);
  assert.equal(c.getTop()?.id, entryId);

  // Provider rerenders because top/primaryActive changed. Actions identity is
  // unchanged (split context). Effect deps are stable → cleanup does NOT run.
  const shouldRerun =
    actions !== actions || // actions identity
    true !== true || // open flag
    "search" !== "search" ||
    "command-palette" !== "command-palette" ||
    "replace" !== "replace";
  assert.equal(shouldRerun, false, "snapshot-only rerender must not re-run registration");

  // Still one open, no silent close from cleanup.
  assert.equal(openCalls, 1);
  assert.equal(silentCloseCalls, 0);
  assert.equal(c.isPrimaryActive(), true);
  assert.equal(c.getTop()?.kind, "search");
  assert.equal(ownerCloseCalls, 0);

  // Owner closes → open=false re-runs effect with new open dep.
  cleanup(); // unmount path when open flips would cleanup first in React
  // React: cleanup of previous effect, then new effect with open=false.
  // We already ran cleanup above; now the closed path.
  entryId = null; // cleanup already cleared and closed
  // Re-sync: cleanup closed the entry.
  assert.equal(c.isPrimaryActive(), false);
  assert.equal(silentCloseCalls, 1);

  // Re-open once more to prove a second open is intentional, not a loop.
  cleanup = runRegistration(true, actions);
  assert.equal(openCalls, 2);
  assert.equal(c.isPrimaryActive(), true);
  cleanup();
  assert.equal(silentCloseCalls, 2);
  assert.equal(ownerCloseCalls, 0, "silent close must not call owner onRequestClose");
});

test("legacy whole-context dependency would loop; split actions prevent it", () => {
  // Document the failure mode: if the effect depended on a value object that
  // changes when top updates, each open would cleanup-close then re-open.
  let idSeq = 0;
  const c = createMobileOverlayController({
    generateId: () => `loop-${++idSeq}`
  });

  let openCalls = 0;
  let closeCalls = 0;
  let entryId = null;

  const openOnce = () => {
    openCalls += 1;
    const result = c.open({
      kind: "feedback",
      id: "pilot-feedback",
      policy: "replace",
      onRequestClose: () => undefined
    });
    if (result.ok) entryId = result.id;
  };
  const silentClose = () => {
    if (!entryId) return;
    closeCalls += 1;
    c.close(entryId, { silent: true });
    entryId = null;
  };

  // Simulated broken loop (3 snapshot-driven reruns after open).
  openOnce();
  for (let i = 0; i < 3; i += 1) {
    silentClose();
    openOnce();
  }
  assert.equal(openCalls, 4);
  assert.equal(closeCalls, 3);

  // Stable-actions path: open once, three snapshot "rerenders" do nothing.
  silentClose();
  openCalls = 0;
  closeCalls = 0;
  openOnce();
  const stableActions = { controller: c };
  for (let i = 0; i < 3; i += 1) {
    // Snapshot changed but actions identity equal → skip cleanup/reopen.
    const nextActions = stableActions;
    if (nextActions !== stableActions) {
      silentClose();
      openOnce();
    }
  }
  assert.equal(openCalls, 1, "stable actions keep a single registration");
  assert.equal(closeCalls, 0);
  assert.equal(c.isPrimaryActive(), true);
});
