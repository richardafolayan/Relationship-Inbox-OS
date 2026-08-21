import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BoundedLruCache,
  createInboxCacheKey,
  createSingleFlight
} from "../apps/runner/src/services/inbox-response-cache.ts";

test("cache keys include only the parsed Inbox contract", () => {
  const input = {
    archived: false,
    needsReply: true,
    platform: "IMESSAGE",
    risk: "RED",
    search: "study group",
    unread: false
  };
  assert.equal(createInboxCacheKey(input), createInboxCacheKey({ ...input }));
  assert.notEqual(createInboxCacheKey(input), createInboxCacheKey({ ...input, unread: true }));
});

test("bounded cache evicts only the least recently used entry", () => {
  const cache = new BoundedLruCache(2);
  cache.set("base", "hot");
  cache.set("first-filter", "one");
  assert.equal(cache.get("base"), "hot");
  cache.set("second-filter", "two");
  assert.equal(cache.get("first-filter"), undefined);
  assert.equal(cache.get("base"), "hot");
  assert.equal(cache.size, 2);
});

test("single-flight shares simultaneous computation and clears after settle", async () => {
  const flight = createSingleFlight();
  let resolveWork;
  let calls = 0;
  const work = () => {
    calls += 1;
    return new Promise((resolve) => { resolveWork = resolve; });
  };
  const first = flight.run("inbox", work);
  assert.equal(flight.has("inbox"), true);
  const second = flight.run("inbox", work);
  assert.equal(calls, 1);
  assert.equal(first, second);
  resolveWork("ready");
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flight.size, 0);
  assert.equal(flight.has("inbox"), false);
  assert.equal(await flight.run("inbox", async () => "fresh"), "fresh");
});

test("the Inbox route uses the semantic LRU, single-flight, and explicit bypass", async () => {
  const source = await readFile(new URL("../apps/runner/src/index.ts", import.meta.url), "utf8");
  const route = source.slice(
    source.indexOf('app.get("/data/inbox"'),
    source.indexOf('app.get("/data/thread/:threadId"')
  );

  assert.match(source, /new BoundedLruCache<CompressedJsonCacheEntry>\(8\)/);
  assert.match(route, /createInboxCacheKey\(\{/);
  assert.match(route, /inboxResponseFlight\.run\(flightKey, computeResponse\)/);
  assert.match(route, /inboxResponseFlight\.has\(flightKey\)/);
  assert.match(route, /req\.get\("cache-control"\)/);
  assert.match(route, /!bypassCache && dataVersion === versionAtStart/);
  assert.doesNotMatch(route, /cacheKey = req\.originalUrl/);
  assert.doesNotMatch(route, /inboxResponseCache\.clear\(\)/);
});
