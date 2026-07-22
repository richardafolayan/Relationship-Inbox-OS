import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APP_VV_HEIGHT_VAR,
  installAppVisualViewport,
  readCssZoom,
  resolveAppVisualViewportHeight
} from "../apps/dashboard/lib/app-visual-viewport.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function ruleBody(source, selectorStart) {
  const start = source.indexOf(selectorStart);
  assert.notEqual(start, -1, `expected source to contain "${selectorStart}"`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

test("document scroll is locked and the shell uses a zoom-safe height chain (#895)", () => {
  const globals = read("apps/dashboard/app/globals.css");
  const shell = read("apps/dashboard/components/layout/app-shell.tsx");
  const canvas = read("apps/dashboard/components/common/canvas.tsx");

  assert.match(globals, /html,\s*body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(globals, /html,\s*body\s*\{[^}]*overscroll-behavior:\s*none/s);
  assert.match(globals, /html,\s*body\s*\{[^}]*height:\s*100%/s);

  // Zoom-safe: percentage chain + optional --app-vv-height, never raw
  // vh/dvh (Safari already divides viewport units under CSS zoom).
  const screenRule = ruleBody(globals, ".h-app-screen");
  assert.match(screenRule, /height:\s*100%/);
  assert.match(screenRule, /var\(--app-vv-height/);
  assert.doesNotMatch(screenRule, /app-vv-offset-top/);
  assert.doesNotMatch(screenRule, /position:\s*relative/);
  assert.doesNotMatch(
    screenRule,
    /\b\d*(\.\d+)?(vh|dvh|svh|lvh)\b/,
    ".h-app-screen must not use viewport units under body { zoom }"
  );
  assert.doesNotMatch(
    screenRule,
    /effective-zoom/,
    "do not divide viewport units by --effective-zoom (Safari double-adjust)"
  );

  // Shell is clipped; mobile main is not the primary scroller.
  assert.match(shell, /grid h-app-screen[^"]*overflow-hidden/);
  assert.match(shell, /overflow-hidden md:overflow-y-auto/);
  assert.match(shell, /installAppVisualViewport/);
  // Bare overflow-y-auto on main (without a breakpoint prefix) must not return.
  assert.doesNotMatch(
    shell,
    /<main className="[^"]*(?<![\w:-])overflow-y-auto/
  );

  // List pages scroll via Canvas on mobile; desktop defers to shell main.
  assert.match(canvas, /pb-10/);
  assert.match(shell, /pathname === "\/inbox"/);
  assert.match(shell, /pathname === "\/archived"/);
});

test("scroll-owner markers document the mobile model for #928 alignment (#895)", () => {
  const shell = read("apps/dashboard/components/layout/app-shell.tsx");
  const canvas = read("apps/dashboard/components/common/canvas.tsx");
  const thread = read("apps/dashboard/app/thread/[id]/page.tsx");

  assert.match(shell, /data-scroll-owner="shell"/);
  assert.match(shell, /data-scroll-owner=\{/);
  assert.match(shell, /\? "child"\s*:\s*"main"/);
  assert.match(read("apps/dashboard/app/inbox/page.tsx"), /data-scroll-owner="list"/);
  assert.match(thread, /data-scroll-owner="thread-messages"/);
});

test("thread keeps its own message scroller rather than relying on shell main (#895)", () => {
  const thread = read("apps/dashboard/app/thread/[id]/page.tsx");

  // Root grid and chat column clip; timeline is the only vertical scroller.
  assert.match(thread, /grid h-full min-h-0 grid-cols-1 overflow-hidden/);
  assert.match(thread, /relative flex h-full min-h-0 flex-col overflow-hidden/);
  assert.match(thread, /min-h-0 flex-1 overflow-y-auto overflow-x-hidden/);
});

test("error and not-found remain scrollable under a locked shell (#895)", () => {
  const errorPage = read("apps/dashboard/app/error.tsx");
  const notFound = read("apps/dashboard/app/not-found.tsx");
  const globalError = read("apps/dashboard/app/global-error.tsx");

  assert.match(errorPage, /h-full min-h-0 overflow-y-auto/);
  assert.match(notFound, /h-full min-h-0 overflow-y-auto/);
  assert.match(globalError, /overflowY:\s*"auto"/);
});

test("resolveAppVisualViewportHeight divides by effective zoom (px path, both engines)", () => {
  assert.equal(resolveAppVisualViewportHeight(800, 1), 800);
  assert.equal(resolveAppVisualViewportHeight(800, 1.3), 800 / 1.3);
  assert.equal(resolveAppVisualViewportHeight(1000, 1.8), 1000 / 1.8);
  assert.equal(resolveAppVisualViewportHeight(500, 0), 500);
  assert.equal(resolveAppVisualViewportHeight(0, 1.3), 0);
  assert.equal(readCssZoom("1.16"), 1.16);
  assert.equal(readCssZoom("normal"), 1);
  assert.equal(readCssZoom(""), 1);
});

test("installAppVisualViewport publishes --app-vv-height and cleans up", () => {
  const props = new Map();
  const root = {
    style: {
      setProperty(name, value) {
        props.set(name, value);
      },
      removeProperty(name) {
        props.delete(name);
      }
    }
  };
  const body = {};
  const listeners = {
    resize: [],
    scroll: [],
    winResize: [],
    uiScale: [],
    storage: []
  };
  const vv = {
    height: 640,
    offsetTop: 24,
    addEventListener(type, fn) {
      listeners[type]?.push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type];
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
  };
  let zoom = "1.25";
  const win = {
    innerHeight: 800,
    document: { documentElement: root, body },
    visualViewport: vv,
    getComputedStyle() {
      return { zoom };
    },
    addEventListener(type, fn) {
      if (type === "resize") listeners.winResize.push(fn);
      else if (type === "inbox-ui-scale") listeners.uiScale.push(fn);
      else if (type === "storage") listeners.storage.push(fn);
    },
    removeEventListener(type, fn) {
      const bucket =
        type === "resize"
          ? listeners.winResize
          : type === "inbox-ui-scale"
            ? listeners.uiScale
            : type === "storage"
              ? listeners.storage
              : null;
      if (!bucket) return;
      const idx = bucket.indexOf(fn);
      if (idx >= 0) bucket.splice(idx, 1);
    }
  };

  const { publish, disconnect } = installAppVisualViewport({
    root,
    body,
    visualViewport: vv,
    win
  });

  assert.equal(props.get(APP_VV_HEIGHT_VAR), `${640 / 1.25}px`);
  assert.equal(listeners.resize.length, 1);
  assert.equal(listeners.scroll.length, 1);
  assert.equal(listeners.winResize.length, 1);
  assert.equal(listeners.uiScale.length, 1);
  assert.equal(listeners.storage.length, 1);

  vv.height = 400;
  vv.offsetTop = 180;
  publish();
  assert.equal(props.get(APP_VV_HEIGHT_VAR), `${400 / 1.25}px`);

  // UI scale / Text Size changes body zoom without a window resize.
  // The publisher must re-read zoom and re-publish on inbox-ui-scale.
  zoom = "1.16";
  for (const fn of listeners.uiScale) fn();
  assert.equal(
    props.get(APP_VV_HEIGHT_VAR),
    `${400 / 1.16}px`,
    "UI scale change must re-publish --app-vv-height with the new zoom"
  );

  disconnect();
  assert.equal(props.has(APP_VV_HEIGHT_VAR), false);
  assert.equal(listeners.resize.length, 0);
  assert.equal(listeners.scroll.length, 0);
  assert.equal(listeners.winResize.length, 0);
  assert.equal(listeners.uiScale.length, 0);
  assert.equal(listeners.storage.length, 0);
});
