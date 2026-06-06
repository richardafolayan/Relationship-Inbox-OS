import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatabaseUrl } from "../apps/runner/dist/config.js";

// Regression cover for the "inbox empty after a clean install" class of bug.
//
// Prisma resolves a *relative* `file:` path in DATABASE_URL against the
// schema directory (packages/core/prisma/), not the project root. The
// .env.example default — DATABASE_URL=file:./data/inbox-os.sqlite — would
// therefore send the runner to packages/core/prisma/data/inbox-os.sqlite,
// while `npm run db:push` writes to <root>/data via an absolute $(pwd)
// override. A student copying .env.example verbatim then sees an empty
// inbox even though their scan wrote rows. resolveDatabaseUrl collapses
// every relative file: URL to one absolute path so both halves agree.

const ROOT = "/Users/example/RelationshipInboxOS";
const ABS_DB = "/Users/example/RelationshipInboxOS/data/inbox-os.sqlite";

test("unset DATABASE_URL falls back to the absolute db file", () => {
  assert.equal(resolveDatabaseUrl(undefined, ROOT, ABS_DB), `file:${ABS_DB}`);
});

test("blank / whitespace DATABASE_URL falls back to the absolute db file", () => {
  assert.equal(resolveDatabaseUrl("", ROOT, ABS_DB), `file:${ABS_DB}`);
  assert.equal(resolveDatabaseUrl("   ", ROOT, ABS_DB), `file:${ABS_DB}`);
});

test("the .env.example relative path resolves to the project-root data file", () => {
  // This is the exact value shipped in .env.example. It must NOT stay
  // schema-relative — it must land on <root>/data/inbox-os.sqlite.
  assert.equal(
    resolveDatabaseUrl("file:./data/inbox-os.sqlite", ROOT, ABS_DB),
    `file:${ROOT}/data/inbox-os.sqlite`
  );
});

test("a bare relative path (no ./) also re-anchors on the project root", () => {
  assert.equal(
    resolveDatabaseUrl("file:data/inbox-os.sqlite", ROOT, ABS_DB),
    `file:${ROOT}/data/inbox-os.sqlite`
  );
});

test("a ../ relative path re-anchors on the project root", () => {
  assert.equal(
    resolveDatabaseUrl("file:../shared/inbox-os.sqlite", ROOT, ABS_DB),
    "file:/Users/example/shared/inbox-os.sqlite"
  );
});

test("an already-absolute file: URL is trusted untouched", () => {
  const absolute = "file:/Users/someone/Elsewhere/data/inbox-os.sqlite";
  assert.equal(resolveDatabaseUrl(absolute, ROOT, ABS_DB), absolute);
});

test("a file:/// absolute URL is trusted untouched", () => {
  const absolute = "file:///Users/someone/Elsewhere/data/inbox-os.sqlite";
  assert.equal(resolveDatabaseUrl(absolute, ROOT, ABS_DB), absolute);
});

test("a non-file datasource URL is passed through untouched", () => {
  // e.g. a remote libsql/turso URL — never rewrite these.
  const remote = "libsql://example.turso.io?authToken=xxx";
  assert.equal(resolveDatabaseUrl(remote, ROOT, ABS_DB), remote);
});

test("surrounding whitespace is trimmed before resolution", () => {
  assert.equal(
    resolveDatabaseUrl("  file:./data/inbox-os.sqlite  ", ROOT, ABS_DB),
    `file:${ROOT}/data/inbox-os.sqlite`
  );
});
