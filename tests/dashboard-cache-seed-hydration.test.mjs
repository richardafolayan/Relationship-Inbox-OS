import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { mutateCache, peekCache } from "../apps/dashboard/lib/api.ts";
import { useCacheSeed } from "../apps/dashboard/lib/use-cache-seed.ts";

// Warm-cache hydration safety (Today page hydration error).
//
// Pages seed initial state from the shared client response cache so
// client-side navigation paints instantly. Seeding through a
// useState(() => peekCache(...)) initializer broke hard loads: the app
// shell's effects warm the in-memory cache from the localStorage snapshot
// before the page boundary hydrates, so the page's first client render
// showed cached data (e.g. <strong>1</strong> in the Today header) while
// the server HTML rendered the empty state - React reported a hydration
// mismatch and regenerated the whole tree client-side. useCacheSeed reads
// the cache through useSyncExternalStore, whose getServerSnapshot pins the
// server + hydration renders to undefined regardless of cache warmth.

test("useCacheSeed renders the empty state on the server even when the cache is warm", () => {
  const path = "/runner/data/inbox";
  mutateCache(path, { rows: [{ id: "t1" }] });
  assert.deepEqual(peekCache(path), { rows: [{ id: "t1" }] }, "cache should be warm for the test");

  function Header() {
    const seed = useCacheSeed(path);
    const rows = seed ? seed.rows : [];
    return React.createElement("strong", null, String(rows.length));
  }

  // renderToString takes the same getServerSnapshot branch the hydration
  // render takes on the client, so this pins the contract: a warm cache
  // must never change server-rendered (= hydration-expected) markup.
  const html = renderToString(React.createElement(Header));
  assert.equal(html, "<strong>0</strong>");
});

test("useCacheSeed still reads the cache outside server rendering", () => {
  const path = "/runner/data/platforms";
  mutateCache(path, [{ platform: "IMESSAGE" }]);
  // Direct peek - the hook's getSnapshot is exactly this read. (The
  // client-mount render path needs a DOM renderer; the live-browser check
  // in the PR covers it. This guards the data plumbing.)
  assert.deepEqual(peekCache(path), [{ platform: "IMESSAGE" }]);
});

// Invariant: no useState initializer may read peekCache. That pattern is
// only hydration-safe when nothing outside the component can warm the
// path's cache entry before the component hydrates. The thread page is the
// one audited exception (its path is only ever fetched by the page itself /
// hover prefetch, and its functional updaters can't use the `state ?? seed`
// form) - see the comment at its seed. Everything else must go through
// lib/use-cache-seed.
const SEED_IN_USESTATE = /useState\s*(?:<[^>\n]*>)?\s*\(\s*\(\)\s*=>[^;]{0,300}?peekCache[<(]\s*["'`A-Za-z]/;
const ALLOWED = new Set(["app/thread/[id]/page.tsx"]);

function dashboardSources(root) {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((rel) => /\.(ts|tsx)$/.test(rel))
    .filter((rel) => !rel.includes("node_modules") && !rel.startsWith(".next"))
    .filter((rel) => rel !== join("lib", "use-cache-seed.ts")); // the sanctioned wrapper documents the banned form
}

test("no useState(() => peekCache(...)) seeds outside the thread page", () => {
  const root = new URL("../apps/dashboard", import.meta.url).pathname;
  const offenders = [];
  for (const rel of dashboardSources(root)) {
    if (ALLOWED.has(rel)) continue;
    const source = readFileSync(join(root, rel), "utf8");
    if (SEED_IN_USESTATE.test(source)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `useState(() => peekCache(...)) leaks warm-cache data into the hydration render. Seed via useCacheSeed (lib/use-cache-seed.ts) instead: ${offenders.join(", ")}`
  );
});

test("the thread page exception still exists where we think it does", () => {
  const root = new URL("../apps/dashboard", import.meta.url).pathname;
  const source = readFileSync(join(root, "app/thread/[id]/page.tsx"), "utf8");
  // If this stops matching, the thread page moved off useState seeding -
  // delete it from ALLOWED above (and this test) so the invariant tightens.
  assert.ok(SEED_IN_USESTATE.test(source), "expected the documented useState(peekCache) seed in the thread page");
});
