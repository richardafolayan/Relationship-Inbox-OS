import test from "node:test";
import assert from "node:assert/strict";

// P1-L12. readThreadSource() hands its result straight to router.push()
// in apps/dashboard/app/thread/[id]/page.tsx. A malicious sessionStorage
// value that resolves off-origin is an open-redirect. The original guard
// rejected literal '//' but missed the backslash form ('/\\evil.com',
// which browsers normalise to '//evil.com') and percent-encoded slashes
// ('/%2Fevil.com', '/%5Cevil.com'). These tests pin the closed door.
//
// Invoked with `node --import tsx --test ...` so the tsx hook resolves
// the .ts import (matches dashboard-thread-source.test.mjs).
const { readThreadSource, __test } = await import(
  "../apps/dashboard/lib/thread-source.ts"
);

function makeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    raw: data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, value);
    }
  };
}

test("readThreadSource: rejects a leading slash + backslash (protocol-relative)", () => {
  const storage = makeStorage({ [__test.KEY]: "/\\evil.example.com" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects a leading slash + double backslash", () => {
  const storage = makeStorage({ [__test.KEY]: "/\\\\evil.example.com" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects an encoded slash after the leading slash", () => {
  const storage = makeStorage({ [__test.KEY]: "/%2Fevil.example.com" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects an encoded backslash after the leading slash", () => {
  const storage = makeStorage({ [__test.KEY]: "/%5Cevil.example.com" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: rejects malformed percent-encoding", () => {
  const storage = makeStorage({ [__test.KEY]: "/%E0%A4%A" });
  assert.equal(readThreadSource(storage), "/today");
});

test("readThreadSource: still accepts a normal local route", () => {
  const storage = makeStorage({ [__test.KEY]: "/inbox?filter=waiting" });
  assert.equal(readThreadSource(storage), "/inbox?filter=waiting");
});

test("readThreadSource: still accepts an encoded query value (not a slash)", () => {
  const storage = makeStorage({ [__test.KEY]: "/inbox?q=a%20b" });
  assert.equal(readThreadSource(storage), "/inbox?q=a%20b");
});
