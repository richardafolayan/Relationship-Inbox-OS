import assert from "node:assert/strict";
import test from "node:test";

import {
  apiGet,
  invalidateCache,
  mutateCache,
  peekCache
} from "../apps/dashboard/lib/api.ts";

test("an invalidated in-flight read cannot overwrite a newer draft cache value", async () => {
  const path = "/runner/data/thread/cache-race";
  let resolveFetch;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => {
    resolveFetch = resolve;
  });

  try {
    invalidateCache(path);
    const staleRead = apiGet(path);
    invalidateCache(path);
    mutateCache(path, { draft: "Saved B", draftUpdatedAt: "2026-08-30T09:05:00.000Z" });

    resolveFetch(new Response(JSON.stringify({
      draft: "",
      draftUpdatedAt: null
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    assert.deepEqual(await staleRead, { draft: "", draftUpdatedAt: null });
    assert.deepEqual(peekCache(path), {
      draft: "Saved B",
      draftUpdatedAt: "2026-08-30T09:05:00.000Z"
    });
  } finally {
    invalidateCache(path);
    globalThis.fetch = priorFetch;
  }
});
