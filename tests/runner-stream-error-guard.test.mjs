import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { streamFileToResponse } from "../apps/runner/dist/utils/fs.js";

// Regression: /artifacts/:type/:name and /data/linkedin-voice-message/:urn used
// a bare createReadStream(path).pipe(res). If the file vanished between the
// existsSync check and the open (cleanup job / EACCES), the stream's async
// 'error' went unhandled → uncaughtException → process.exit(1) crashed the whole
// runner. streamFileToResponse must instead answer 404 and never throw.

function fakeRes() {
  const res = new Writable({ write(_c, _e, cb) { cb(); } });
  res.headersSent = false;
  res.statusCode = null;
  res.body = null;
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (o) { this.body = o; this.headersSent = true; return this; };
  return res;
}

test("missing file resolves to 404 and does NOT throw (no uncaughtException)", async () => {
  const res = fakeRes();
  let threw = false;
  try {
    streamFileToResponse("/no/such/file/anywhere.bin", res);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "must not throw synchronously");
  // let the async 'error' event fire
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(res.statusCode, 404, "missing file -> 404 before headers sent");
  assert.ok(res.body && res.body.error, "sends a JSON error body instead of crashing");
});

test("a custom notFoundStatus is honoured", async () => {
  const res = fakeRes();
  streamFileToResponse("/no/such/file2.bin", res, 410);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(res.statusCode, 410);
});
