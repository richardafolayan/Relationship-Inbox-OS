import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below — see test:all in the root package.json.
const { readInboxQueryParam } = await import("../apps/dashboard/lib/inbox-query.ts");

// readInboxQueryParam seeds the inbox search box from a ?q= deep link.
// The thread participant popover's "Find 1:1 thread" action navigates to
// /inbox?q=<handle>; the inbox redesign dropped the handling that applied
// it (regression of issue #211). These tests pin the fix.

test("reads q from a leading-? search string", () => {
  assert.equal(readInboxQueryParam("?q=Serena"), "Serena");
});

test("reads q without a leading ?", () => {
  assert.equal(readInboxQueryParam("q=Serena"), "Serena");
});

test("decodes percent-encoded handles (e.g. a +phone number)", () => {
  assert.equal(readInboxQueryParam("?q=%2B447911123456"), "+447911123456");
});

test("trims surrounding whitespace", () => {
  assert.equal(readInboxQueryParam("?q=%20%20Lola%20%20"), "Lola");
});

test("returns empty string when q is absent", () => {
  assert.equal(readInboxQueryParam("?tab=overdue"), "");
});

test("returns empty string for an empty search", () => {
  assert.equal(readInboxQueryParam(""), "");
});

test("picks q out of a multi-param query", () => {
  assert.equal(readInboxQueryParam("?tab=all&q=George%20Jones&sort=name"), "George Jones");
});
