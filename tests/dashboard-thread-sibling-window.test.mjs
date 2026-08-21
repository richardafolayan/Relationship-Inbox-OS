import assert from "node:assert/strict";
import test from "node:test";

const { boundedSiblingRows, INITIAL_SIBLING_LIMIT, SIBLING_PAGE_SIZE } = await import(
  "../apps/dashboard/lib/thread-sibling-window.ts"
);

const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `thread-${index}`, index }));

test("large sibling collections mount only the initial bounded window", () => {
  const visible = boundedSiblingRows(rows, INITIAL_SIBLING_LIMIT, rows[0]);
  assert.equal(visible.length, 80);
  assert.deepEqual(visible.map((row) => row.id), rows.slice(0, 80).map((row) => row.id));
});

test("the selected thread stays mounted even when outside the leading window", () => {
  const selected = rows[999];
  const visible = boundedSiblingRows(rows, INITIAL_SIBLING_LIMIT, selected);
  assert.equal(visible.length, 80);
  assert.equal(visible.at(-1), selected);
  assert.equal(new Set(visible.map((row) => row.id)).size, 80);
});

test("user expansion grows the bounded window by one page", () => {
  const expanded = boundedSiblingRows(rows, INITIAL_SIBLING_LIMIT + SIBLING_PAGE_SIZE, rows[999]);
  assert.equal(expanded.length, 160);
  assert.equal(expanded.at(-1)?.id, "thread-999");
});
