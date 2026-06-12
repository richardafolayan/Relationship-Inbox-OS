import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine } from "../apps/runner/dist/services/run-logger.js";

// Regression: appendLine() is the single chokepoint for every trace write
// (pretty.log / events.ndjson / actions.csv) and runs on the logging hot
// path inside executeTracedOperation. Before the fix it called appendFileSync
// unguarded, so a synchronous write failure (disk full, permissions, a
// removed run dir) propagated out and crashed/masked the operation it was
// logging. Logging must be best-effort and never throw.

test("appendLine writes a line to a valid path", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-logger-append-ok-"));
  const file = join(dir, "trace.log");

  appendLine(file, "first");
  appendLine(file, "second");

  assert.equal(readFileSync(file, "utf8"), "first\nsecond\n");
});

test("appendLine swallows a synchronous write failure instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-logger-append-fail-"));
  // Create a regular file, then treat it as a directory. Appending to a
  // child path under a file fails deterministically (ENOTDIR) on every
  // platform/uid, unlike permission tricks that no-op as root/CI.
  const fileAsParent = join(dir, "not-a-dir");
  writeFileSync(fileAsParent, "x", "utf8");
  const unwritable = join(fileAsParent, "trace.log");

  // The assertion: this must NOT throw. Pre-fix, appendFileSync throws
  // ENOTDIR and the error escapes; post-fix it is caught and swallowed.
  assert.doesNotThrow(() => {
    appendLine(unwritable, "this write cannot land");
  });
});
