import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSrc = readFileSync(
  fileURLToPath(new URL("../apps/runner/src/index.ts", import.meta.url)),
  "utf8"
);

// /data/thread builds the suggested-replies recent window + cacheKey from the
// *paginated* message slice. On a scroll-up fetch (beforeMessageId set) that
// window is older, so the cacheKey can never match the live one. Without a
// guard the route regenerated replies from the stale window AND persisted
// them, clobbering the live cache (wasted AI spend + flapping suggestions on
// the next live fetch). A paginated fetch must serve persisted replies as-is.

test("a servePersistedOnly flag is derived from beforeMessageId", () => {
  assert.match(indexSrc, /const servePersistedOnly = Boolean\(beforeMessageId\);/);
});

test("a paginated fetch serves persisted replies, bypassing the cacheKey compare", () => {
  // Cache fields now read from the CANONICAL sibling (aiThread) so a split
  // iMessage conversation serves the live row's replies; servePersistedOnly
  // still short-circuits the cacheKey compare on a scroll-up fetch.
  assert.match(
    indexSrc,
    /\(servePersistedOnly \|\| aiThread\.suggestedRepliesCacheKey === cacheKey\) && aiThread\.suggestedRepliesJson/
  );
});

test("a paginated fetch never kicks off regeneration/persistence", () => {
  assert.match(
    indexSrc,
    /if \(!servePersistedOnly && !suggestedRepliesInFlight\.has\(inFlightKey\)\)/
  );
});
