import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

const { createCompressedJsonCacheEntry } = await import(
  "../apps/runner/src/services/compressed-json-cache.ts"
);

test("compressed JSON cache preserves the exact response payload", () => {
  const body = {
    rows: Array.from({ length: 100 }, (_, index) => ({ id: `thread-${index}`, preview: "Repeated local inbox text" })),
    summary: { unreadThreads: 20 }
  };
  const entry = createCompressedJsonCacheEntry(body, 1234);

  assert.equal(entry.expires, 1234);
  assert.deepEqual(JSON.parse(entry.json), body);
  assert.equal(gunzipSync(entry.gzip).toString("utf8"), entry.json);
  assert.ok(entry.gzip.byteLength < Buffer.byteLength(entry.json));
});
