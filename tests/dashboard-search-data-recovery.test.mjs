import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const paletteSource = read("apps/dashboard/components/layout/command-palette.tsx");
const mobileSearchSource = read("apps/dashboard/components/layout/mobile-search.tsx");
const hookPath = new URL("../apps/dashboard/lib/use-search-inbox.ts", import.meta.url);
const hookSource = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";

async function loadStateModel() {
  return import("../apps/dashboard/lib/search-inbox-state.ts");
}

test("Search distinguishes an initial inbox failure from a loaded empty inbox", async () => {
  const {
    beginSearchInboxLoad,
    completeSearchInboxLoad,
    createSearchInboxState,
    failSearchInboxLoad,
    shouldShowSearchInboxEmptyState
  } = await loadStateModel();

  let state = createSearchInboxState();
  assert.equal(state.phase, "loading");
  assert.equal(shouldShowSearchInboxEmptyState(state, false), false);

  state = failSearchInboxLoad(state);
  assert.equal(state.phase, "error");
  assert.equal(shouldShowSearchInboxEmptyState(state, false), false);

  state = beginSearchInboxLoad(state);
  assert.equal(state.phase, "loading");
  state = completeSearchInboxLoad([]);
  assert.equal(state.phase, "ready");
  assert.equal(shouldShowSearchInboxEmptyState(state, false), true);
});

test("Search retains its last good conversations when a refresh fails", async () => {
  const {
    beginSearchInboxLoad,
    completeSearchInboxLoad,
    createSearchInboxState,
    failSearchInboxLoad,
    shouldShowSearchInboxEmptyState
  } = await loadStateModel();

  const oldRows = [{ id: "old-thread", personName: "Lanre" }];
  let state = createSearchInboxState();
  state = completeSearchInboxLoad(oldRows);
  state = beginSearchInboxLoad(state);
  assert.equal(state.phase, "refreshing");
  assert.deepEqual(state.rows, oldRows);

  state = failSearchInboxLoad(state);
  assert.equal(state.phase, "error");
  assert.deepEqual(state.rows, oldRows);
  assert.equal(shouldShowSearchInboxEmptyState(state, false), false);
});

test("desktop and mobile Search share the same recoverable inbox lifecycle", () => {
  assert.match(paletteSource, /useSearchInbox/);
  assert.match(mobileSearchSource, /useSearchInbox/);
  assert.match(paletteSource, /shouldShowSearchInboxEmptyState/);
  assert.match(mobileSearchSource, /shouldShowSearchInboxEmptyState/);
});

test("#966: Search refreshes on runner recovery and removes its listener", () => {
  assert.match(hookSource, /const onResync = \(\) => void refresh\(\)/);
  assert.match(hookSource, /addEventListener\("runner-resync", onResync\)/);
  assert.match(hookSource, /removeEventListener\("runner-resync", onResync\)/);
  assert.match(hookSource, /apiGet<InboxResponse>\("\/runner\/data\/inbox"\)/);
});

test("failed conversation loading offers retry instead of a false no-results message", () => {
  for (const source of [paletteSource, mobileSearchSource]) {
    assert.match(source, /Conversations are temporarily unavailable/);
    assert.match(source, /Try again/);
    assert.match(source, /Conversation results may be out of date/);
    assert.match(source, /Loading conversations…/);
    assert.match(source, /Refreshing conversations…/);
  }
});
