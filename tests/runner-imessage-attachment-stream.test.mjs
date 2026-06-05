import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { streamIMessageAttachment } from "../apps/runner/dist/services/imessage-attachment-server.js";

// A minimal stand-in for Express's Response: it is a Writable (so the file
// stream can pipe into it) plus the handful of members pipeFile() touches.
class MockRes extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = null;
    this.jsonBody = null;
    this.headersSent = false; // mirrors Express: false until headers flush
    this.sawErrorResponse = false;
  }
  setHeader(key, value) {
    this.headers[key] = value;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.jsonBody = body;
    this.sawErrorResponse = true;
    return this;
  }
  _write(_chunk, _enc, cb) {
    cb(); // accept and discard the bytes
  }
}

// Regression test for the CRITICAL finding: pipeFile() streamed a file to the
// response with no 'error' handler, so a read failure mid-stream surfaced as
// an unhandled 'error' event -> process-level uncaughtException -> the runner
// exits, taking every platform down. We reproduce the read failure
// deterministically: a *directory* passes existsSync/statSync but makes
// createReadStream emit EISDIR on read. Before the fix this throws an
// unhandled error and crashes the test process; after the fix the handler
// sends a 500 and the process stays up.
test("streamIMessageAttachment: a read error mid-stream is handled, not fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-eisdir-"));
  try {
    const res = new MockRes();
    await streamIMessageAttachment({
      absolutePath: dir, // exists; createReadStream(dir) -> EISDIR
      mimeType: "application/octet-stream",
      transferName: "note.bin",
      filename: null,
      res,
    });
    // The stream 'error' fires on a later tick; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(res.sawErrorResponse, true, "the stream error handler should have run");
    assert.equal(res.statusCode, 500, "the client should get a 500, not a process crash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Sanity: a normal small file streams through without tripping the error path.
test("streamIMessageAttachment: a readable file streams without error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-ok-"));
  const file = join(dir, "ok.bin");
  writeFileSync(file, "hello world");
  try {
    const res = new MockRes();
    await streamIMessageAttachment({
      absolutePath: file,
      mimeType: "application/octet-stream",
      transferName: "ok.bin",
      filename: null,
      res,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(res.sawErrorResponse, false, "a good file should not hit the error path");
    assert.equal(res.headers["Content-Type"], "application/octet-stream");
    assert.match(res.headers["Content-Disposition"], /filename="ok\.bin"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
