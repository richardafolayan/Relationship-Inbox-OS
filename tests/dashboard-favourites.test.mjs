import test from "node:test";
import assert from "node:assert/strict";

// favourites.ts + today.ts are framework-free, so the tsx loader resolves these
// .ts imports directly (matches the dashboard-today-queue.test.mjs pattern).
const { favouritesFirst, isFavouriteRow } = await import("../apps/dashboard/lib/favourites.ts");
const { sortTodayQueue } = await import("../apps/dashboard/lib/today.ts");

// R-0066 / #483: favourited contacts float to the top of the list they already
// belong to, WITHOUT reordering across risk levels and preserving the order
// within the favourite / non-favourite split.

test("favouritesFirst lifts favourites to the front, preserving order within each group", () => {
  const rows = [
    { id: "a", personFavourite: false },
    { id: "b", personFavourite: true },
    { id: "c", personFavourite: false },
    { id: "d", personFavourite: true }
  ];
  assert.deepEqual(favouritesFirst(rows).map((r) => r.id), ["b", "d", "a", "c"]);
});

test("favouritesFirst is a no-op when nothing is favourited", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(favouritesFirst(rows).map((r) => r.id), ["a", "b", "c"]);
});

test("favouritesFirst does not mutate its input", () => {
  const rows = [{ id: "a", personFavourite: false }, { id: "b", personFavourite: true }];
  favouritesFirst(rows);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
});

test("isFavouriteRow is true only for personFavourite === true", () => {
  assert.equal(isFavouriteRow({ personFavourite: true }), true);
  assert.equal(isFavouriteRow({ personFavourite: false }), false);
  assert.equal(isFavouriteRow({}), false);
});

const row = (over) => ({
  id: "x",
  riskLevel: "GREEN",
  lastInboundAt: "2026-06-01T00:00:00.000Z",
  personFavourite: false,
  ...over
});

test("sortTodayQueue: risk bucket first, favourites within a bucket, oldest within the split", () => {
  const rows = [
    row({ id: "red-old", riskLevel: "RED", lastInboundAt: "2026-06-01T00:00:00.000Z", personFavourite: false }),
    row({ id: "red-fav", riskLevel: "RED", lastInboundAt: "2026-06-03T00:00:00.000Z", personFavourite: true }),
    row({ id: "amber-fav", riskLevel: "AMBER", lastInboundAt: "2026-06-02T00:00:00.000Z", personFavourite: true }),
    row({ id: "green-fav", riskLevel: "GREEN", lastInboundAt: "2026-05-01T00:00:00.000Z", personFavourite: true })
  ];
  // Within RED, the favourite leads even though its inbound is newer than the
  // plain row's — favourite is the tiebreaker before oldest-waiting.
  assert.deepEqual(
    sortTodayQueue(rows).map((r) => r.id),
    ["red-fav", "red-old", "amber-fav", "green-fav"]
  );
});

test("sortTodayQueue: a fresh favourite never outranks an overdue non-favourite", () => {
  const rows = [
    row({ id: "green-fav", riskLevel: "GREEN", personFavourite: true }),
    row({ id: "red-plain", riskLevel: "RED", personFavourite: false })
  ];
  assert.deepEqual(sortTodayQueue(rows).map((r) => r.id), ["red-plain", "green-fav"]);
});

test("sortTodayQueue: oldest-waiting leads within the same risk + favourite split", () => {
  const rows = [
    row({ id: "newer", riskLevel: "AMBER", lastInboundAt: "2026-06-04T00:00:00.000Z", personFavourite: false }),
    row({ id: "older", riskLevel: "AMBER", lastInboundAt: "2026-06-01T00:00:00.000Z", personFavourite: false })
  ];
  assert.deepEqual(sortTodayQueue(rows).map((r) => r.id), ["older", "newer"]);
});
