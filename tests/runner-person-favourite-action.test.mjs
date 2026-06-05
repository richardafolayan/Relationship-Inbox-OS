import test from "node:test";
import assert from "node:assert/strict";
import { decidePersonFavouriteAction } from "../apps/runner/dist/services/person-favourite-action.js";

// POST /control/person/:id/favourite backs the favourite star (R-0066 / #483).
// The handler is a thin shell over this pure decision: a bare POST toggles,
// while the dashboard sends an explicit `favourite` so an optimistic star
// can't drift out of sync. Setting a contact to the state they're already in
// is an idempotent no-op (no DB write), mirroring the rename "confirm" path.

const NOW = new Date("2026-06-05T12:00:00.000Z");
const EARLIER = new Date("2026-01-01T00:00:00.000Z");

test("a bare POST toggles a non-favourite ON and stamps favouritedAt", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: null }, {}, NOW);
  assert.equal(d.status, 200);
  assert.deepEqual(d.write, { favouritedAt: NOW });
  assert.deepEqual(d.body, { status: "ok", favourite: true });
});

test("a bare POST toggles a favourite OFF and clears favouritedAt", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: EARLIER }, {}, NOW);
  assert.equal(d.status, 200);
  assert.deepEqual(d.write, { favouritedAt: null });
  assert.deepEqual(d.body, { status: "ok", favourite: false });
});

test("explicit favourite:true favourites a non-favourite", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: null }, { favourite: true }, NOW);
  assert.deepEqual(d.write, { favouritedAt: NOW });
  assert.deepEqual(d.body, { status: "ok", favourite: true });
});

test("explicit favourite:false unfavourites a favourite", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: EARLIER }, { favourite: false }, NOW);
  assert.deepEqual(d.write, { favouritedAt: null });
  assert.deepEqual(d.body, { status: "ok", favourite: false });
});

test("favourite:true on an already-favourite is an idempotent no-op (no write)", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: EARLIER }, { favourite: true }, NOW);
  assert.equal(d.status, 200);
  assert.equal(d.write, null, "no DB write on a no-op");
  assert.deepEqual(d.body, { status: "ok", favourite: true });
});

test("favourite:false on a non-favourite is an idempotent no-op (no write)", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: null }, { favourite: false }, NOW);
  assert.equal(d.status, 200);
  assert.equal(d.write, null);
  assert.deepEqual(d.body, { status: "ok", favourite: false });
});

test("action:set without a favourite flag means set-to-false", () => {
  const d = decidePersonFavouriteAction({ favouritedAt: EARLIER }, { action: "set" }, NOW);
  assert.deepEqual(d.write, { favouritedAt: null });
  assert.deepEqual(d.body, { status: "ok", favourite: false });
});
