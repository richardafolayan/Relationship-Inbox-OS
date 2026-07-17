import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const THREAD_PAGE = readFileSync(join(ROOT, "apps/dashboard/app/thread/[id]/page.tsx"), "utf8");
const SETTINGS_PAGE = readFileSync(join(ROOT, "apps/dashboard/app/settings/page.tsx"), "utf8");

test("WhatsApp AUTH_REQUIRED recovery deep-links to Platforms settings", () => {
  assert.match(THREAD_PAGE, /case "AUTH_REQUIRED"/);
  assert.match(THREAD_PAGE, /label: "Reconnect WhatsApp"/);
  assert.match(
    THREAD_PAGE,
    /label: "Reconnect WhatsApp"[\s\S]{0,160}router\.push\("\/settings#whatsapp"\)/,
    "Reconnect WhatsApp must open Settings Platforms (via #whatsapp deep link), not the default Setup tab"
  );
  assert.doesNotMatch(
    THREAD_PAGE,
    /label: "Reconnect WhatsApp"[\s\S]{0,160}router\.push\("\/settings"\)/
  );
});

test("Settings hash routing activates the Platforms section", () => {
  assert.match(SETTINGS_PAGE, /id: "platforms"/);
  assert.match(SETTINGS_PAGE, /function tabFromHash/);
  // tabFromHash accepts SettingsTabId values, so #platforms selects Platforms.
  // #whatsapp is an alias that also lands on Platforms for reconnect flows.
  assert.match(SETTINGS_PAGE, /clean === "whatsapp"/);
  assert.match(
    SETTINGS_PAGE,
    /function isSettingsTabId[\s\S]*?SETTINGS_TABS\.some\(\(tab\) => tab\.id === value\)/
  );
  assert.match(SETTINGS_PAGE, /const tab = tabFromHash\(window\.location\.hash\)/);
  assert.match(SETTINGS_PAGE, /if \(tab\) setActiveTab\(tab\)/);
  assert.match(SETTINGS_PAGE, /activeTab === "platforms"/);
  assert.match(SETTINGS_PAGE, /WhatsAppConnect/);
});

test("Settings can focus the WhatsApp connect card from deep links", () => {
  // Stable anchor is always mounted on Platforms (not gated on whatsappRow).
  assert.match(SETTINGS_PAGE, /id="whatsapp-connect"/);
  assert.doesNotMatch(
    SETTINGS_PAGE,
    /whatsappRow\s*\?\s*\(\s*<div id="whatsapp-connect"/,
    "#whatsapp-connect must not be gated on whatsappRow (async platformRows race)"
  );
  assert.match(SETTINGS_PAGE, /window\.location\.hash === ["']#whatsapp["']/);
  assert.match(SETTINGS_PAGE, /getElementById\(["']whatsapp-connect["']\)/);
  // Scroll window (not a one-shot pending flag cleared on first paint).
  assert.match(SETTINGS_PAGE, /whatsappScrollUntilRef/);
  assert.match(SETTINGS_PAGE, /WHATSAPP_SCROLL_WINDOW_MS\s*=\s*2000/);
  assert.match(SETTINGS_PAGE, /requestAnimationFrame/);
  assert.match(
    SETTINGS_PAGE,
    /\[activeTab,\s*platformRows\]/,
    "must re-attempt scroll when platformRows load while hash is #whatsapp"
  );
  // First successful scroll must not close the window (layout may still grow).
  assert.match(
    SETTINGS_PAGE,
    /Do not close the window on first paint|Do not treat first paint as final|cards above may still load/
  );
  // Debounced re-scroll on platformRows change during the open window.
  assert.match(
    SETTINGS_PAGE,
    /Debounce so a burst of platformRows updates|setTimeout\(\(\) => \{[\s\S]{0,120}requestAnimationFrame/
  );
});

/**
 * Runtime model of the empty-rows → rows-loaded scroll race fixed for #889.
 * Mirrors settings/page.tsx: open a 2s window on #whatsapp, scroll when the
 * anchor exists without closing the window, and re-scroll when platformRows
 * changes while the window is still open.
 */
function createWhatsappScrollController({ now, scrollIntoView, getAnchorPresent }) {
  let scrollUntil = 0;
  const SCROLL_WINDOW_MS = 2000;
  const scrolls = [];

  const inWindow = (hash) => hash === "#whatsapp" && now() < scrollUntil;

  const openWindow = () => {
    scrollUntil = now() + SCROLL_WINDOW_MS;
  };

  const closeWindow = () => {
    scrollUntil = 0;
  };

  const tryScroll = (hash) => {
    if (!inWindow(hash)) return false;
    if (!getAnchorPresent()) return false;
    // Success must not clear the window: cards above may still inject.
    scrollIntoView();
    scrolls.push({ at: now(), reason: "try" });
    return true;
  };

  const onPlatformRowsChange = (hash) => {
    if (!inWindow(hash)) return false;
    if (!getAnchorPresent()) return false;
    scrollIntoView();
    scrolls.push({ at: now(), reason: "platformRows" });
    return true;
  };

  return { openWindow, closeWindow, tryScroll, onPlatformRowsChange, scrolls, inWindow: () => inWindow("#whatsapp") };
}

test("empty platformRows then rows-loaded still re-scrolls WhatsApp anchor", () => {
  let t = 0;
  let anchorPresent = false;
  let scrollCalls = 0;

  const ctrl = createWhatsappScrollController({
    now: () => t,
    scrollIntoView: () => {
      scrollCalls += 1;
    },
    getAnchorPresent: () => anchorPresent
  });

  // Navigate to /settings#whatsapp with empty platformRows (anchor not painted).
  ctrl.openWindow();
  assert.equal(ctrl.tryScroll("#whatsapp"), false, "no scroll before anchor mounts");
  assert.equal(scrollCalls, 0);

  // Platforms tab paints: only #whatsapp-connect is in the grid (empty rows).
  t = 10;
  anchorPresent = true;
  assert.equal(ctrl.tryScroll("#whatsapp"), true, "first paint scrolls");
  assert.equal(scrollCalls, 1);
  assert.equal(ctrl.inWindow(), true, "window must stay open after first successful scroll");

  // platformRows resolves; iMessage / LinkedIn cards inject above WhatsApp.
  t = 80;
  assert.equal(
    ctrl.onPlatformRowsChange("#whatsapp"),
    true,
    "must re-scroll when platformRows loads while window open"
  );
  assert.equal(scrollCalls, 2);
  assert.deepEqual(
    ctrl.scrolls.map((s) => s.reason),
    ["try", "platformRows"]
  );

  // After the 2s window, further row updates must not scroll.
  t = 2100;
  assert.equal(ctrl.inWindow(), false);
  assert.equal(ctrl.onPlatformRowsChange("#whatsapp"), false);
  assert.equal(scrollCalls, 2);
});

test("leaving #whatsapp closes the scroll window", () => {
  let t = 0;
  const ctrl = createWhatsappScrollController({
    now: () => t,
    scrollIntoView: () => {},
    getAnchorPresent: () => true
  });
  ctrl.openWindow();
  assert.equal(ctrl.tryScroll("#whatsapp"), true);
  ctrl.closeWindow();
  assert.equal(ctrl.onPlatformRowsChange("#whatsapp"), false);
});
