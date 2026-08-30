import assert from "node:assert/strict";
import test from "node:test";

import {
  apiGet,
  invalidateCache,
  mutateCache,
  peekCache
} from "../apps/dashboard/lib/api.ts";

test("an invalidated in-flight read resolves to the newer draft cache value", async () => {
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

    assert.deepEqual(await staleRead, {
      draft: "Saved B",
      draftUpdatedAt: "2026-08-30T09:05:00.000Z"
    });
    assert.deepEqual(peekCache(path), {
      draft: "Saved B",
      draftUpdatedAt: "2026-08-30T09:05:00.000Z"
    });
  } finally {
    invalidateCache(path);
    globalThis.fetch = priorFetch;
  }
});

test("an invalidated in-flight SWR read cannot invoke its stale callback", async () => {
  const path = "/runner/data/thread/scheduled-race";
  let resolveFetch;
  let callbackValue = null;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => {
    resolveFetch = resolve;
  });

  try {
    invalidateCache(path);
    mutateCache(path, { scheduledSends: [] });
    assert.deepEqual(
      await apiGet(path, {
        swr: true,
        onFresh: (value) => {
          callbackValue = value;
        }
      }),
      { scheduledSends: [] }
    );

    invalidateCache(path);
    mutateCache(path, { scheduledSends: [{ clientSendId: "accepted" }] });
    resolveFetch(new Response(JSON.stringify({ scheduledSends: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(callbackValue, null);
    assert.deepEqual(peekCache(path), {
      scheduledSends: [{ clientSendId: "accepted" }]
    });
  } finally {
    invalidateCache(path);
    globalThis.fetch = priorFetch;
  }
});

test("persistent snapshot removal failures never turn cache invalidation into a product failure", () => {
  const path = "/runner/data/thread/storage-denied";
  const priorWindow = globalThis.window;
  let throwOnRemove = false;
  const values = new Map();
  const storage = {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      if (throwOnRemove) throw new DOMException("denied", "SecurityError");
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };

  try {
    globalThis.window = { localStorage: storage };
    mutateCache(path, { draft: "Saved successfully" });
    throwOnRemove = true;
    assert.doesNotThrow(() => invalidateCache(path));
    assert.equal(peekCache(path), undefined);
  } finally {
    throwOnRemove = false;
    invalidateCache(path);
    globalThis.window = priorWindow;
  }
});
