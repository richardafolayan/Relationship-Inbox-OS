import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  buildMobileSearchSections,
  flattenMobileSearchSections,
  rememberRecentQuery,
  rememberRecentThread,
  parseRecentQueries,
  parseRecentThreads,
  resolveVisualViewportHeight,
  resolveVisualViewportOffset,
  readCssZoom,
  isPhoneSearchWidth,
  conversationFromRow,
  recordSearchReturn,
  resolveSearchCloseTarget,
  resolveSearchCloseHref,
  resolveSearchAttentionKind,
  buildInAppHref,
  buildSearchHistoryHref,
  readSearchQueryParam,
  rememberSearchScroll,
  readSearchScroll,
  MOBILE_SEARCH_RETURN_KEY,
  MOBILE_SEARCH_RETURN_FALLBACK,
  MOBILE_SEARCH_SCROLL_KEY,
  MOBILE_SEARCH_QUERY_PARAM
} = await import("../apps/dashboard/lib/mobile-search.ts");

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileSearchSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "mobile-search.tsx"),
  "utf8"
);
const mobileDockSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "mobile-dock.tsx"),
  "utf8"
);
const appShellSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "app-shell.tsx"),
  "utf8"
);
const commandPaletteSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "command-palette.tsx"),
  "utf8"
);
const searchPageSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "app", "search", "page.tsx"),
  "utf8"
);

function thread(id, personName, preview, platform = "LINKEDIN") {
  return {
    id,
    personName,
    preview,
    platform,
    unreadCount: 0,
    riskLevel: "GREEN",
    needsReply: false,
    lastMessageAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    slaCountdown: ""
  };
}

test("#903: conversations are prioritised over pages and actions", () => {
  const sections = buildMobileSearchSections({
    threads: [
      thread("t1", "Sophie Clarke", "thanks for the intro"),
      thread("t2", "Brandon", "Quick 20-min chat this week?")
    ],
    query: "so"
  });

  assert.ok(sections.conversations.length >= 1);
  assert.equal(sections.conversations[0].label, "Sophie Clarke");
  assert.equal(sections.conversations[0].group, "conversations");

  // Broader query that also hits "Go to Settings" / scan actions: conversations
  // must still occupy the front of the flattened list.
  const mixed = buildMobileSearchSections({
    threads: [thread("t1", "Sam", "hello there")],
    query: "s"
  });
  const flat = flattenMobileSearchSections(mixed);
  assert.ok(flat.length > 0);
  assert.equal(flat[0].group, "conversations");
  const firstCommand = flat.findIndex((item) => item.group !== "conversations");
  if (firstCommand !== -1) {
    assert.ok(flat.slice(0, firstCommand).every((item) => item.group === "conversations"));
  }
});

test("#903: empty query still lists conversations before pages and actions", () => {
  const sections = buildMobileSearchSections({
    threads: [thread("t1", "Nina", "call me later")],
    query: ""
  });
  assert.equal(sections.conversations[0].personName, "Nina");
  assert.ok(sections.pagesAndActions.length > 0);
  const flat = flattenMobileSearchSections(sections);
  assert.equal(flat[0].group, "conversations");
  assert.ok(flat.some((item) => item.kindLabel === "Page"));
  assert.ok(flat.some((item) => item.href === "/reconnect"));
});

test("#903: person name and message content both match", () => {
  const sections = buildMobileSearchSections({
    threads: [
      thread(
        "t1",
        "Brandon",
        "Hi - I wanted to flag a senior product role. Quick 20-min chat this week?"
      )
    ],
    query: "20-min"
  });
  assert.equal(sections.conversations.length, 1);
  assert.equal(sections.conversations[0].label, "Brandon");

  const byName = buildMobileSearchSections({
    threads: [thread("t1", "Priya 07", "see you soon")],
    query: "priya"
  });
  assert.equal(byName.conversations.length, 1);
});

test("#903: recent threads surface under an empty query", () => {
  const sections = buildMobileSearchSections({
    threads: [thread("t-new", "New Person", "hello")],
    query: "",
    recentThreads: [
      {
        threadId: "t-old",
        personName: "Recent Friend",
        platform: "WHATSAPP",
        preview: "see you tomorrow"
      }
    ]
  });
  assert.equal(sections.conversations[0].threadId, "t-old");
  assert.equal(sections.conversations[0].kindLabel, "whatsapp");
  assert.ok(sections.conversations.some((item) => item.threadId === "t-new"));
});

test("#903: recent query and thread memory helpers are order-stable", () => {
  assert.deepEqual(rememberRecentQuery(["alpha", "beta"], "gamma"), ["gamma", "alpha", "beta"]);
  assert.deepEqual(rememberRecentQuery(["Alpha", "beta"], "alpha"), ["alpha", "beta"]);
  assert.deepEqual(parseRecentQueries(JSON.stringify(["one", "two", 3, ""])), ["one", "two"]);
  assert.deepEqual(parseRecentQueries("not-json"), []);

  const next = rememberRecentThread(
    [{ threadId: "a", personName: "A", platform: "LINKEDIN", preview: "x" }],
    { threadId: "b", personName: "B", platform: "IMESSAGE", preview: "y" }
  );
  assert.equal(next[0].threadId, "b");
  assert.equal(next[1].threadId, "a");
  assert.deepEqual(parseRecentThreads("[]"), []);
  assert.equal(parseRecentThreads(null).length, 0);
});

test("#903: visual viewport height keeps results above the keyboard", () => {
  assert.equal(resolveVisualViewportHeight({ visualHeight: 420, layoutHeight: 800 }), 420);
  assert.equal(resolveVisualViewportHeight({ visualHeight: null, layoutHeight: 800 }), 800);
  assert.equal(resolveVisualViewportHeight({ visualHeight: 0, layoutHeight: 0 }), null);
  assert.equal(resolveVisualViewportOffset(64), 64);
  assert.equal(resolveVisualViewportOffset(null), 0);
  assert.equal(isPhoneSearchWidth(390), true);
  assert.equal(isPhoneSearchWidth(1024), false);
});

test("#903: visualViewport height and offset divide by body zoom (pre-zoom px)", () => {
  // Same defect class as #921: fixed overlay applies explicit px under
  // body { zoom: var(--effective-zoom) }. Raw vv px would paint ~zoom× tall.
  assert.equal(resolveVisualViewportHeight({ visualHeight: 800, effectiveZoom: 1 }), 800);
  assert.equal(
    resolveVisualViewportHeight({ visualHeight: 800, effectiveZoom: 1.16 }),
    800 / 1.16
  );
  assert.equal(
    resolveVisualViewportHeight({ visualHeight: 640, layoutHeight: 900, effectiveZoom: 1.25 }),
    640 / 1.25
  );
  assert.equal(
    resolveVisualViewportHeight({ visualHeight: null, layoutHeight: 800, effectiveZoom: 1.3 }),
    800 / 1.3
  );
  assert.equal(resolveVisualViewportOffset(64, 1.16), 64 / 1.16);
  assert.equal(resolveVisualViewportOffset(0, 1.16), 0);
  assert.equal(resolveVisualViewportOffset(null, 1.16), 0);
  assert.equal(readCssZoom("1.16"), 1.16);
  assert.equal(readCssZoom(1.25), 1.25);
  assert.equal(readCssZoom("normal"), 1);
  assert.equal(readCssZoom(0), 1);
  assert.equal(readCssZoom(""), 1);

  // Component must pass computed body zoom and re-sync on UI scale change.
  assert.match(mobileSearchSrc, /readCssZoom/);
  assert.match(mobileSearchSrc, /getComputedStyle\(document\.body\)\.zoom/);
  assert.match(mobileSearchSrc, /effectiveZoom:\s*zoom/);
  assert.match(mobileSearchSrc, /onUiScaleChange\(syncViewport\)/);
});

test("#903: conversation rows expose platform without desktop-only glyphs", () => {
  const item = conversationFromRow(thread("t1", "Sophie", "hi there", "WHATSAPP"));
  assert.equal(item.kindLabel, "whatsapp");
  assert.doesNotMatch(item.label, /↵|↩|↗/);
  assert.doesNotMatch(mobileSearchSrc, /↵/);
  assert.match(mobileSearchSrc, /Pages and actions/);
  assert.match(mobileSearchSrc, /Search conversations/);
  assert.match(mobileSearchSrc, /min-h-\[56px\]/);
  assert.match(mobileSearchSrc, /visualViewport/);
  assert.match(mobileSearchSrc, /aria-label="Back"/);
  assert.match(mobileSearchSrc, />\s*Cancel\s*</);
});

test("#903: phone search is a dedicated route, not the desktop palette", () => {
  assert.match(searchPageSrc, /MobileSearchScreen/);
  assert.match(mobileDockSrc, /href: "\/search"/);
  assert.match(mobileDockSrc, /pathname === "\/search"/);
  assert.doesNotMatch(mobileDockSrc, /onOpenSearch/);
  assert.match(appShellSrc, /router\.push\("\/search"\)/);
  assert.match(appShellSrc, /max-width: 767px/);
  // Desktop palette remains a floating dialog with keyboard enter glyph.
  assert.match(commandPaletteSrc, /export function CommandPalette/);
  assert.match(commandPaletteSrc, /↵/);
  assert.match(commandPaletteSrc, /sm:place-items-start sm:justify-items-center/);
});

test("#903: mobile search focuses the field and wires result scroller", () => {
  assert.match(mobileSearchSrc, /inputRef\.current\?\.focus/);
  assert.match(mobileSearchSrc, /data-mobile-search-results/);
  assert.match(mobileSearchSrc, /data-mobile-search-screen/);
  assert.match(mobileSearchSrc, /overflow-y-auto/);
  assert.match(mobileSearchSrc, /flex-shrink-0/);
});

function makeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    raw: data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    }
  };
}

test("#903: Close uses app-owned return route via replace, not history.length or push", () => {
  assert.doesNotMatch(mobileSearchSrc, /history\.length\s*>\s*1/);
  assert.doesNotMatch(mobileSearchSrc, /router\.back\(/);
  assert.match(mobileSearchSrc, /resolveSearchCloseHref/);
  // replace avoids stacking a second predecessor and Search ↔ back bounce.
  assert.match(mobileSearchSrc, /router\.replace\(resolveSearchCloseHref\(\)\)/);
  assert.doesNotMatch(mobileSearchSrc, /router\.push\(resolveSearchCloseHref\(\)\)/);
  // Full safe href (pathname + search + hash), not pathname alone.
  assert.match(appShellSrc, /recordSearchReturn\(buildInAppHref\(/);
  assert.match(appShellSrc, /useSearchParams/);
  assert.match(appShellSrc, /window\.location\.hash/);
});

test("#903: Search surfaces offline/degraded/scanning attention inside the overlay", () => {
  // Full-screen Search is z-90 over TopStatus z-30. forceSurface alone is not
  // visible; the stacking fix lives in Search UI as an in-screen banner.
  assert.match(mobileSearchSrc, /data-mobile-search-attention/);
  assert.match(mobileSearchSrc, /resolveSearchAttentionKind/);
  assert.match(mobileSearchSrc, /App helper paused/);
  assert.match(mobileSearchSrc, /Start runner/);
  assert.match(mobileSearchSrc, /settings#platforms/);
  assert.match(mobileSearchSrc, /Scanning…/);
  assert.match(mobileSearchSrc, /z-\[90\]/);

  assert.equal(
    resolveSearchAttentionKind({
      ready: true,
      runnerOffline: true,
      hasDegraded: false,
      scanning: false
    }),
    "offline"
  );
  assert.equal(
    resolveSearchAttentionKind({
      ready: true,
      runnerOffline: false,
      hasDegraded: true,
      scanning: false
    }),
    "degraded"
  );
  assert.equal(
    resolveSearchAttentionKind({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      scanning: true
    }),
    "scanning"
  );
  assert.equal(
    resolveSearchAttentionKind({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      scanning: false
    }),
    null
  );
  assert.equal(
    resolveSearchAttentionKind({
      ready: false,
      runnerOffline: false,
      hasDegraded: true,
      scanning: true
    }),
    null,
    "cold mount must not flash attention before first poll"
  );
});

test("#903: direct-entry Close falls back to /today", () => {
  const empty = makeStorage();
  assert.equal(resolveSearchCloseTarget(empty), MOBILE_SEARCH_RETURN_FALLBACK);
  assert.equal(resolveSearchCloseHref(empty), "/today");
  assert.equal(resolveSearchCloseTarget(null), "/today");
});

test("#903: external-referrer style empty session still stays in-app", () => {
  // history.length would be > 1 after arriving from an external site, but we
  // never consult it. With no recorded app predecessor, Close → /today.
  const storage = makeStorage();
  assert.equal(resolveSearchCloseHref(storage), "/today");
  assert.notEqual(resolveSearchCloseHref(storage), "back");
});

test("#903: in-app predecessor is restored on Close", () => {
  const storage = makeStorage();
  recordSearchReturn("/inbox", storage);
  assert.equal(storage.raw.get(MOBILE_SEARCH_RETURN_KEY), "/inbox");
  assert.equal(resolveSearchCloseHref(storage), "/inbox");

  recordSearchReturn("/search", storage);
  assert.equal(
    resolveSearchCloseHref(storage),
    "/inbox",
    "landing on /search must not overwrite the predecessor"
  );

  recordSearchReturn("/settings", storage);
  assert.equal(resolveSearchCloseHref(storage), "/settings");
});

test("#903: unsafe return paths are rejected in favour of /today", () => {
  for (const bad of ["//evil.example.com", "/\\evil.example.com", "/%2Fevil.example.com", "https://evil.example.com"]) {
    const storage = makeStorage({ [MOBILE_SEARCH_RETURN_KEY]: bad });
    assert.equal(resolveSearchCloseHref(storage), "/today", bad);
  }
});

test("#903: recordSearchReturn stores full safe href including query and hash", () => {
  const storage = makeStorage();
  recordSearchReturn("/settings#platforms", storage);
  assert.equal(resolveSearchCloseHref(storage), "/settings#platforms");

  recordSearchReturn("/inbox?filter=needs-reply", storage);
  assert.equal(resolveSearchCloseHref(storage), "/inbox?filter=needs-reply");

  recordSearchReturn(buildInAppHref("/people", "?tab=all", "#top"), storage);
  assert.equal(resolveSearchCloseHref(storage), "/people?tab=all#top");

  // /search (with or without query) must not overwrite the predecessor.
  recordSearchReturn("/search?q=priya", storage);
  assert.equal(resolveSearchCloseHref(storage), "/people?tab=all#top");
  recordSearchReturn("/search", storage);
  assert.equal(resolveSearchCloseHref(storage), "/people?tab=all#top");
});

test("#903: buildInAppHref and safe path validation", () => {
  assert.equal(buildInAppHref("/settings", "", "#platforms"), "/settings#platforms");
  assert.equal(buildInAppHref("/settings", "tab=1", "platforms"), "/settings?tab=1#platforms");
  assert.equal(buildInAppHref("/inbox", "?q=a", ""), "/inbox?q=a");
  assert.equal(buildInAppHref("/today"), "/today");
});

test("#903: Search query persists in history href for result → Back", () => {
  assert.equal(buildSearchHistoryHref(""), "/search");
  assert.equal(buildSearchHistoryHref("  "), "/search");
  assert.equal(buildSearchHistoryHref("priya"), `/search?${MOBILE_SEARCH_QUERY_PARAM}=priya`);
  assert.equal(
    buildSearchHistoryHref("a b"),
    `/search?${MOBILE_SEARCH_QUERY_PARAM}=a%20b`
  );
  assert.equal(readSearchQueryParam("?q=hello"), "hello");
  assert.equal(readSearchQueryParam(new URLSearchParams("q=world")), "world");
  assert.equal(readSearchQueryParam(""), "");

  // Component wires URL restore + history replace + scroll memory.
  assert.match(mobileSearchSrc, /buildSearchHistoryHref/);
  assert.match(mobileSearchSrc, /readSearchQueryParam/);
  assert.match(mobileSearchSrc, /history\.replaceState/);
  assert.match(mobileSearchSrc, /rememberSearchScroll/);
  assert.match(mobileSearchSrc, /readSearchScroll/);
  assert.match(mobileSearchSrc, /useSearchParams/);
});

test("#903: Search list scroll is remembered for result → Back restore", () => {
  const storage = makeStorage();
  rememberSearchScroll(240, storage);
  assert.equal(storage.raw.get(MOBILE_SEARCH_SCROLL_KEY), "240");
  assert.equal(readSearchScroll(storage), 240);
  rememberSearchScroll(0, storage);
  assert.equal(readSearchScroll(storage), 0);
});
