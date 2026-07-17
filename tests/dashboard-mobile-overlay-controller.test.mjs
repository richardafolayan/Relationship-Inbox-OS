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
  captureFocus,
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

test("history popstate (system Back) closes the active overlay via onBack", () => {
  const listeners = new Set();
  let state = null;
  const history = {
    get state() {
      return state;
    },
    pushState(data) {
      state = data;
    },
    back() {
      state = null;
      for (const listener of [...listeners]) listener({ state });
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    }
  };

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

  assert.equal(state?.[MOBILE_OVERLAY_HISTORY_KEY], "sheet-1");

  // Simulate system Back: popstate without going through history.back() from us.
  for (const listener of [...listeners]) listener({ state: null });

  assert.equal(closed, true);
  assert.equal(c.isPrimaryActive(), false);

  binding.release();
});

test("programmatic history release calls history.back without re-dismissing", () => {
  const listeners = new Set();
  let state = { prior: true };
  let backCalls = 0;
  const history = {
    get state() {
      return state;
    },
    pushState(data) {
      state = data;
    },
    back() {
      backCalls += 1;
      state = { prior: true };
      for (const listener of [...listeners]) listener({ state });
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    }
  };

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
  assert.equal(backCalls, 1);
  assert.equal(onBackCalls, 0, "UI close must not re-fire onBack via popstate");
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
});
