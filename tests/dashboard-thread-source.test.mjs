import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below (matches the existing dashboard-action-items.test.mjs pattern).
const {
  canNavigateBackToSameOrigin,
  readPreviousNavigationEntryUrl,
  recordThreadSource,
  readThreadSource,
  __test
} = await import(
  "../apps/dashboard/lib/thread-source.ts"
);

// A Map-backed stand-in for window.sessionStorage so the helpers can be
// exercised under node:test without jsdom. Mirrors getItem / setItem.
function makeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    raw: data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, value);
    }
  };
}

// Issue #336 / R-0025. These tests pin the contract the thread page's
// archive handler relies on: the most recent non-thread route wins,
// thread routes are never recorded (so opening a thread doesn't clobber
// the previous source), and the reader degrades to /today whenever the
// storage is empty, unsafe, or unavailable.

test("recordThreadSource: stores a list route verbatim", () => {
  const storage = makeStorage();
  recordThreadSource("/inbox", storage);
  assert.equal(storage.raw.get(__test.KEY), "/inbox");
});

test("recordThreadSource: preserves query strings", () => {
  const storage = makeStorage();
  recordThreadSource("/inbox?filter=waiting", storage);
  assert.equal(storage.raw.get(__test.KEY), "/inbox?filter=waiting");
});

test("recordThreadSource: ignores thread routes so the source isn't clobbered", () => {
  const storage = makeStorage({ [__test.KEY]: "/inbox" });
  recordThreadSource("/thread/abc123", storage);
  assert.equal(storage.raw.get(__test.KEY), "/inbox");
});

test("recordThreadSource: ignores empty or absolute URLs", () => {
  const storage = makeStorage({ [__test.KEY]: "/inbox" });
  recordThreadSource("", storage);
  recordThreadSource(null, storage);
  recordThreadSource(undefined, storage);
  recordThreadSource("https://evil.example.com/whoops", storage);
  assert.equal(storage.raw.get(__test.KEY), "/inbox");
});

test("recordThreadSource: no-op when storage is unavailable", () => {
  assert.doesNotThrow(() => recordThreadSource("/inbox", null));
});

test("recordThreadSource: swallows setItem throws (quota, security errors)", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceeded");
    }
  };
  assert.doesNotThrow(() => recordThreadSource("/inbox", storage));
});

test("readThreadSource: returns the stored value when safe", () => {
  const storage = makeStorage({ [__test.KEY]: "/reconnect" });
  assert.equal(readThreadSource(storage), "/reconnect");
});

test("readThreadSource: falls back to /today when nothing is stored", () => {
  const storage = makeStorage();
  assert.equal(readThreadSource(storage), __test.FALLBACK);
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects a thread route in storage (defensive)", () => {
  const storage = makeStorage({ [__test.KEY]: "/thread/abc" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects protocol-relative or non-local paths", () => {
  const protocolRelative = makeStorage({ [__test.KEY]: "//evil.example.com" });
  const nonLocal = makeStorage({ [__test.KEY]: "https://evil.example.com" });
  assert.equal(readThreadSource(protocolRelative), "/today");
  assert.equal(readThreadSource(nonLocal), "/today");
});

test("readThreadSource: falls back when storage is unavailable", () => {
  assert.equal(readThreadSource(null), "/today");
});

test("readThreadSource: swallows getItem throws", () => {
  const storage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {}
  };
  assert.equal(readThreadSource(storage), "/today");
});

test("thread back uses browser history only when the referrer is same-origin", () => {
  assert.equal(canNavigateBackToSameOrigin(2, "https://tovi.local/inbox", "https://tovi.local"), true);
  assert.equal(canNavigateBackToSameOrigin(1, "https://tovi.local/inbox", "https://tovi.local"), false);
  assert.equal(canNavigateBackToSameOrigin(2, "https://external.example/link", "https://tovi.local"), false);
  assert.equal(canNavigateBackToSameOrigin(2, "not a url", "https://tovi.local"), false);
});

test("thread back recognizes same-origin SPA history when document.referrer is stale", () => {
  assert.equal(
    canNavigateBackToSameOrigin(
      4,
      "https://external.example/landing",
      "https://tovi.local",
      "https://tovi.local/thread/A"
    ),
    true
  );
  assert.equal(
    canNavigateBackToSameOrigin(
      4,
      "https://external.example/landing",
      "https://tovi.local",
      "https://external.example/previous"
    ),
    false
  );
});

test("previous navigation entry detection feature-degrades for WebKit", () => {
  assert.equal(readPreviousNavigationEntryUrl(undefined), undefined);
  assert.equal(readPreviousNavigationEntryUrl({}), undefined);
  assert.equal(
    readPreviousNavigationEntryUrl({
      currentEntry: { index: 3 },
      entries: () => [
        { index: 1, url: "https://tovi.local/inbox" },
        { index: 2, url: "https://tovi.local/thread/A" },
        { index: 3, url: "https://tovi.local/thread/B" }
      ]
    }),
    "https://tovi.local/thread/A"
  );
});
