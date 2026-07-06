import test from "node:test";
import assert from "node:assert/strict";
import { decideArchivedResurface } from "../apps/runner/dist/services/scan-queue.js";

// Bug (Richard, 2026-07-05): an archived thread ("Tim") never returned to the
// active inbox even though the contact messaged again after being archived.
// The scan upsert never cleared archivedAt on a new inbound, so archiving
// silently hid the person's future replies. decideArchivedResurface is the
// twin of the snooze-clear: bring an archived thread back when a genuinely
// new inbound needs a reply.

const JUN5 = new Date("2026-06-05T01:26:07Z"); // Tim archived
const JUL5 = new Date("2026-07-05T13:51:59Z"); // Tim's new inbound

test("resurfaces Tim: archived, then a newer inbound that needs a reply", () => {
  assert.equal(
    decideArchivedResurface({ archivedAt: JUN5, needsReply: true, lastInboundAt: JUL5 }),
    true
  );
});

test("does not resurface a thread that was never archived", () => {
  assert.equal(
    decideArchivedResurface({ archivedAt: null, needsReply: true, lastInboundAt: JUL5 }),
    false
  );
});

test("does not resurface when the thread no longer needs a reply", () => {
  // The operator replied from the archived view — leave it archived.
  assert.equal(
    decideArchivedResurface({ archivedAt: JUN5, needsReply: false, lastInboundAt: JUL5 }),
    false
  );
});

test("does not resurface on a rescan of the SAME history (inbound older than the archive)", () => {
  // Operator deliberately archived a thread whose last inbound predates the
  // archive; no new message has arrived, so it must stay archived.
  assert.equal(
    decideArchivedResurface({ archivedAt: JUL5, needsReply: true, lastInboundAt: JUN5 }),
    false
  );
});

test("does not resurface when there is no inbound at all", () => {
  assert.equal(
    decideArchivedResurface({ archivedAt: JUN5, needsReply: true, lastInboundAt: null }),
    false
  );
});

test("an inbound exactly at the archive instant is not 'after' the archive", () => {
  const t = new Date("2026-06-05T01:26:07Z");
  assert.equal(
    decideArchivedResurface({ archivedAt: t, needsReply: true, lastInboundAt: new Date(t) }),
    false
  );
});
