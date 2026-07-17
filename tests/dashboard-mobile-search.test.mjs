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
  isPhoneSearchWidth,
  conversationFromRow
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
  assert.match(commandPaletteSrc, /place-items-start justify-items-center/);
});

test("#903: mobile search focuses the field and wires result scroller", () => {
  assert.match(mobileSearchSrc, /inputRef\.current\?\.focus/);
  assert.match(mobileSearchSrc, /data-mobile-search-results/);
  assert.match(mobileSearchSrc, /data-mobile-search-screen/);
  assert.match(mobileSearchSrc, /overflow-y-auto/);
  assert.match(mobileSearchSrc, /flex-shrink-0/);
});
