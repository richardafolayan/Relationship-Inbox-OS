import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// #897: mobile Inbox / Archived use a contained list scroller. Dock is a
// shell layout row (not a fixed overlay every page pads for). Safe-area
// bottom has one owner. Desktop Canvas long-page model stays intact.
// Controls are a compact shrink-0 layout row (not a nested vertical
// scroller). The conversation list is the only vertical scroll owner.
// Main does not double-scroll on mobile list routes (#921-style).

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const shell = read("../apps/dashboard/components/layout/app-shell.tsx");
const dock = read("../apps/dashboard/components/layout/mobile-dock.tsx");
const canvas = read("../apps/dashboard/components/common/canvas.tsx");
const inbox = read("../apps/dashboard/app/inbox/page.tsx");
const archived = read("../apps/dashboard/app/archived/page.tsx");
const today = read("../apps/dashboard/app/today/page.tsx");

test("MobileDock is an in-flow shell row, not a fixed viewport overlay", () => {
  assert.match(dock, /data-testid="mobile-dock"/);
  assert.match(dock, /className="[^"]*\brelative\b[^"]*\bshrink-0\b/);
  assert.doesNotMatch(
    dock,
    /className="[^"]*\bfixed\b[^"]*\binset-x-0\b[^"]*\bbottom-0\b/,
    "dock must not be position:fixed bottom overlay"
  );
  assert.match(
    dock,
    /pb-\[env\(safe-area-inset-bottom\)\]/,
    "dock owns the home-indicator safe-area inset"
  );
});

test("AppShell places MobileDock inside the content column after main", () => {
  const contentStart = shell.indexOf('className="flex h-app-screen min-h-0 flex-col overflow-hidden"');
  assert.ok(contentStart > 0, "content column is a clipped full-height flex stack");
  const mainIdx = shell.indexOf("<main", contentStart);
  const dockIdx = shell.indexOf("<MobileDock", contentStart);
  const contentEnd = shell.indexOf("</div>", dockIdx);
  assert.ok(mainIdx > contentStart, "main lives in the content column");
  assert.ok(dockIdx > mainIdx, "dock follows main so it is a bottom shell row");
  assert.ok(contentEnd > dockIdx, "dock closes inside the content column");
  // Dock is not a sibling of the content column (old fixed overlay slot).
  const afterContent = shell.slice(contentEnd);
  assert.doesNotMatch(
    afterContent.slice(0, 200),
    /<MobileDock/,
    "dock must not sit outside the content column as a fixed overlay sibling"
  );
});

test("Canvas no longer reserves huge mobile padding for a fixed dock", () => {
  assert.doesNotMatch(
    canvas,
    /pb-\[calc\(132px\+env\(safe-area-inset-bottom\)\)\]/,
    "default Canvas must drop the 132px dock-clearance padding"
  );
  assert.doesNotMatch(
    canvas,
    /pb-\[calc\(\d+px\+env\(safe-area-inset-bottom\)\)\]/,
    "Canvas must not double-own safe-area via large calc padding"
  );
  assert.match(
    canvas,
    /md:pb-\[120px\]/,
    "desktop Canvas long-page bottom padding stays"
  );
  assert.doesNotMatch(
    today,
    /pb-\[calc\(96px\+env\(safe-area-inset-bottom\)\)\]/,
    "Today must not keep a separate dock-clearance pad once dock owns its row"
  );
  // Modest cushion above the in-flow dock on long pages (People/Settings).
  assert.match(
    canvas,
    /pb-10/,
    "default Canvas keeps a calm bottom pad above the in-flow dock"
  );
});

test("Inbox mobile layout: compact fixed controls + single list scroller", () => {
  assert.match(
    inbox,
    /data-testid="inbox-controls"/,
    "controls cluster is a named layout region"
  );
  assert.match(
    inbox,
    /data-testid="inbox-list-scroller"/,
    "conversation list has a dedicated scroller"
  );
  assert.match(
    inbox,
    /flex h-full min-h-0 flex-col overflow-hidden/,
    "mobile root fills the shell viewport without growing past it"
  );
  assert.match(
    inbox,
    /md:block md:h-auto md:overflow-visible md:pb-\[120px\]/,
    "desktop keeps the long-page Canvas model"
  );

  // Controls are a fixed shrink-0 layout row. No height cap, no nested
  // vertical scroller (that recreated the two-pane confusion of #897).
  const controlsBlock = inbox.match(
    /data-testid="inbox-controls"\s*className="([^"]+)"/
  );
  assert.ok(controlsBlock, "inbox-controls has a className");
  assert.match(controlsBlock[1], /\bshrink-0\b/, "controls stay natural height");
  assert.doesNotMatch(
    controlsBlock[1],
    /max-h-\[42dvh\]/,
    "controls must not cap height with a nested scroll budget"
  );
  assert.doesNotMatch(
    controlsBlock[1],
    /overflow-y-auto/,
    "controls must not be a vertical scroller"
  );

  // No nested controls scroller anywhere under the controls region.
  assert.doesNotMatch(
    inbox,
    /min-h-0 flex-1 overflow-y-auto overscroll-contain md:flex-none md:overflow-visible/,
    "must not reintroduce the nested upper-controls scroller"
  );
  assert.doesNotMatch(
    inbox,
    /max-h-\[42dvh\]/,
    "max-h-[42dvh] nested scroller pattern must stay removed"
  );

  // PageHead is compact on this contained list screen.
  assert.match(
    inbox,
    /<PageHead[\s\S]*?\bcompact\b/,
    "Inbox uses compact PageHead on mobile"
  );

  // Search input must allow shrinking on narrow widths (match Archived).
  assert.match(
    inbox,
    /placeholder="Search people, keywords…"[\s\S]*?className="min-w-0 flex-1/,
    "Inbox search input has min-w-0 like Archived"
  );

  const scrollerClass = inbox.match(
    /data-testid="inbox-list-scroller"\s*data-scroll-owner="list"\s*className="([^"]+)"/
  );
  assert.ok(scrollerClass, "list scroller has data-scroll-owner=list and className");
  assert.match(scrollerClass[1], /overflow-y-auto/);
  assert.match(scrollerClass[1], /overscroll-contain/);
  assert.match(scrollerClass[1], /flex-1/);
  assert.match(scrollerClass[1], /min-h-0/);
  assert.match(scrollerClass[1], /md:overflow-visible/);
});

test("AppShell main is not a second scroller on mobile list routes", () => {
  assert.match(
    shell,
    /data-scroll-owner=\{/,
    "main declares a scroll-owner invariant"
  );
  assert.match(
    shell,
    /overflow-hidden md:overflow-y-auto/,
    "contained routes: main clips on mobile, long-page on desktop"
  );
  assert.match(
    shell,
    /pathname === "\/inbox"/,
    "inbox opts into contained main scroll"
  );
  assert.match(
    shell,
    /pathname === "\/archived"/,
    "archived opts into contained main scroll"
  );
  assert.match(
    shell,
    /pathname\.startsWith\("\/thread\/"\)/,
    "thread opts into contained main scroll"
  );
});

test("Inbox keeps search, filters, select, pagination and bulk actions", () => {
  assert.match(inbox, /placeholder="Search people, keywords…"/);
  assert.match(inbox, /FiltersPopover/);
  assert.match(inbox, /SelectGlyph/);
  assert.match(inbox, /data-testid="bulk-action-bar"/);
  assert.match(inbox, /nextInboxVisibleCount|hasMoreRows|Show .* more/);
  // Bulk bar is sticky inside the list scroller (not fixed over the dock).
  assert.match(
    inbox,
    /data-testid="bulk-action-bar"[\s\S]*?sticky bottom-3/,
    "bulk bar sticks within the list scroller above the dock"
  );
});

test("Archived shares the mobile contained-list shell", () => {
  assert.match(archived, /data-testid="archived-controls"/);
  assert.match(archived, /data-testid="archived-list-scroller"/);
  assert.match(archived, /flex h-full min-h-0 flex-col overflow-hidden/);
  assert.match(archived, /md:block md:h-auto md:overflow-visible md:pb-\[120px\]/);
  const controlsBlock = archived.match(
    /data-testid="archived-controls"\s*className="([^"]+)"/
  );
  assert.ok(controlsBlock, "archived-controls has a className");
  assert.match(controlsBlock[1], /\bshrink-0\b/);
  assert.doesNotMatch(controlsBlock[1], /max-h-\[42dvh\]/);
  assert.doesNotMatch(controlsBlock[1], /overflow-y-auto/);
  assert.doesNotMatch(
    archived,
    /max-h-\[42dvh\]/,
    "Archived must not reintroduce nested controls height cap"
  );
  assert.match(
    archived,
    /placeholder="Search archived[\s\S]*?className="min-w-0 flex-1/,
    "Archived search input has min-w-0"
  );
  const scrollerClass = archived.match(
    /data-testid="archived-list-scroller"\s*data-scroll-owner="list"\s*className="([^"]+)"/
  );
  assert.ok(scrollerClass);
  assert.match(scrollerClass[1], /overflow-y-auto/);
  assert.match(scrollerClass[1], /overscroll-contain/);
  assert.match(scrollerClass[1], /min-h-0/);
  assert.match(archived, /data-testid="archived-bulk-bar"/);
  assert.match(archived, /SelectGlyph/);
  assert.match(archived, /placeholder="Search archived/);
});

test("safe-area bottom has one primary owner (the dock)", () => {
  // Canvas defaults must not also apply env(safe-area-inset-bottom).
  const canvasDefault = canvas.match(
    /export function Canvas[\s\S]*?className=\{cn\(\s*"([^"]+)"/
  );
  assert.ok(canvasDefault, "Canvas default class string found");
  assert.doesNotMatch(
    canvasDefault[1],
    /safe-area-inset-bottom/,
    "Canvas default classes must not claim safe-area-inset-bottom"
  );
  assert.match(dock, /pb-\[env\(safe-area-inset-bottom\)\]/);
});
