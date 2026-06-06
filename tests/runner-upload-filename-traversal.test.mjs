import test from "node:test";
import assert from "node:assert/strict";
import { safeUploadFilename } from "../apps/runner/dist/utils/fs.js";

// Regression for PH6: multipart upload filenames came from client-supplied
// file.originalname verbatim. multer path.join()s the name onto a per-request
// dir, so a traversing originalname ("../../..") escaped that dir = arbitrary
// file write (and, on the dictation route, arbitrary directory deletion via the
// cleanup rmSync). safeUploadFilename must reduce any client name to a single
// safe path segment, never a separator or a "."/".." segment.

test("safeUploadFilename strips path traversal to a basename", () => {
  assert.equal(safeUploadFilename("../../../../etc/passwd", "fallback.bin"), "passwd");
  assert.equal(safeUploadFilename("../../foo.png", "fallback.bin"), "foo.png");
  assert.equal(safeUploadFilename("a/b/c.webm", "fallback.bin"), "c.webm");
  assert.equal(safeUploadFilename("foo/../bar", "fallback.bin"), "bar");
});

test("safeUploadFilename never returns a separator or '..'/'.' segment", () => {
  for (const evil of ["../../../../etc/passwd", "a/b/c", "foo/../bar", "/", "./../x"]) {
    const out = safeUploadFilename(evil, "fallback.bin");
    assert.ok(!out.includes("/"), `must not contain '/': ${out}`);
    assert.ok(!out.includes("\\"), `must not contain backslash: ${out}`);
    assert.notEqual(out, "..");
    assert.notEqual(out, ".");
  }
});

test("safeUploadFilename falls back for empty/degenerate names", () => {
  assert.equal(safeUploadFilename("", "dictation.webm"), "dictation.webm");
  assert.equal(safeUploadFilename(undefined, "dictation.webm"), "dictation.webm");
  assert.equal(safeUploadFilename("..", "dictation.webm"), "dictation.webm");
  assert.equal(safeUploadFilename(".", "dictation.webm"), "dictation.webm");
  assert.equal(safeUploadFilename("/", "dictation.webm"), "dictation.webm");
});

test("safeUploadFilename keeps a normal name and extension intact", () => {
  assert.equal(safeUploadFilename("photo.png", "fallback.bin"), "photo.png");
  assert.equal(safeUploadFilename("dictation.webm", "dictation.webm"), "dictation.webm");
  // disallowed chars are replaced (not dropped), so the extension survives
  assert.equal(safeUploadFilename("my file (1).PNG", "fallback.bin"), "my_file__1_.PNG");
});
