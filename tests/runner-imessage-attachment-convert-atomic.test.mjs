import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertOnce } from "../apps/runner/dist/services/imessage-attachment-server.js";

// Regression test for the LOW finding (P1-L7): convertOnce wrote the converter
// output straight into the final cache path `dst`. Two concurrent requests for
// the same uncached source both saw existsSync(dst) === false and both wrote
// dst, so a later existsSync(dst) could observe a half-written file and stream
// a truncated attachment. The fix writes to a unique temp file and atomically
// renames onto dst, so the converter never touches dst directly and a
// concurrent reader only ever sees a complete file.

function makeSource(dir, name) {
  const src = join(dir, name);
  writeFileSync(src, "source-bytes");
  return src;
}

test("convertOnce: the converter is never handed the final dst path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "convonce-tmp-"));
  try {
    const src = makeSource(dir, "a.heic");
    let seenDst = null;
    const result = await convertOnce(src, "jpg", async (_src, dst) => {
      seenDst = dst;
      writeFileSync(dst, "CONVERTED");
    });
    assert.ok(result, "conversion should succeed and return the cache path");
    // The path handed to the converter must be a temp sibling, not the final
    // cache file — that indirection is what makes the publish atomic.
    assert.notEqual(seenDst, result, "converter must write a temp file, not dst directly");
    assert.match(seenDst, /\.tmp$/, "converter target should be a .tmp file");
    assert.equal(readFileSync(result, "utf8"), "CONVERTED", "dst holds the complete output");
    assert.equal(existsSync(seenDst), false, "temp file is renamed away, not left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convertOnce: two concurrent conversions of the same source both return complete content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "convonce-race-"));
  try {
    const src = makeSource(dir, "b.caf");
    const FULL = "X".repeat(4096);
    // A deliberately slow converter: write the full content, then yield, so two
    // overlapping calls are genuinely in flight at the same time. With the old
    // direct-to-dst code a reader could catch a partial dst; with the fix each
    // call writes its own temp file and the rename publishes atomically.
    const slowRun = async (_src, dst) => {
      await new Promise((r) => setTimeout(r, 25));
      writeFileSync(dst, FULL);
    };
    const [a, b] = await Promise.all([
      convertOnce(src, "m4a", slowRun),
      convertOnce(src, "m4a", slowRun),
    ]);
    assert.equal(a, b, "both calls resolve to the same cache path");
    assert.ok(a && existsSync(a), "the cache file exists");
    assert.equal(readFileSync(a, "utf8"), FULL, "the published cache file is complete, not truncated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convertOnce: a failing converter leaves no temp file and returns null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "convonce-fail-"));
  try {
    const src = makeSource(dir, "c.mov");
    let seenDst = null;
    const result = await convertOnce(src, "mov.m4a", async (_src, dst) => {
      seenDst = dst;
      writeFileSync(dst, "partial");
      throw new Error("converter blew up");
    });
    assert.equal(result, null, "a thrown converter yields null");
    assert.ok(seenDst, "converter ran");
    assert.equal(existsSync(seenDst), false, "the partial temp file is cleaned up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
