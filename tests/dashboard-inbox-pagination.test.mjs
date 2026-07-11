import test from "node:test";
import assert from "node:assert/strict";

const {
  INBOX_INITIAL_VISIBLE_ROWS,
  INBOX_PAGE_ROWS,
  nextInboxVisibleCount,
  windowInboxSections
} = await import("../apps/dashboard/lib/inbox-pagination.ts");

test("inbox rendering starts with a bounded row window", () => {
  assert.equal(INBOX_INITIAL_VISIBLE_ROWS, 80);
  assert.equal(INBOX_PAGE_ROWS, 80);
});

test("show more advances one page without exceeding the result count", () => {
  assert.equal(nextInboxVisibleCount(80, 1_000), 160);
  assert.equal(nextInboxVisibleCount(960, 1_000), 1_000);
  assert.equal(nextInboxVisibleCount(80, 24), 24);
});

test("grouped inbox sections share one global render window", () => {
  const sections = [
    { key: "overdue", items: Array.from({ length: 50 }, (_, id) => `red-${id}`) },
    { key: "waiting", items: Array.from({ length: 50 }, (_, id) => `amber-${id}`) },
    { key: "fresh", items: Array.from({ length: 50 }, (_, id) => `green-${id}`) }
  ];

  const visible = windowInboxSections(sections, 80);
  assert.deepEqual(visible.map((section) => [section.key, section.items.length]), [
    ["overdue", 50],
    ["waiting", 30]
  ]);
});

test("an empty window renders no sections", () => {
  assert.deepEqual(windowInboxSections([{ key: "fresh", items: [1, 2, 3] }], 0), []);
});
