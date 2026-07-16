import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runnerSource = () =>
  readFile(new URL("../apps/runner/src/index.ts", import.meta.url), "utf8");

test("favourites endpoint returns the five most-recently pinned contacts", async () => {
  const source = await runnerSource();
  assert.match(source, /app\.get\("\/data\/favourites"/);
  // Only favourited people, newest star first, capped at five.
  assert.match(source, /favouritedAt: \{ not: null \}/);
  assert.match(source, /orderBy: \{ favouritedAt: "desc" \}/);
  assert.match(source, /take: MENU_FAVOURITE_LIMIT/);
  assert.match(source, /const MENU_FAVOURITE_LIMIT = 5/);
});

test("favourites endpoint carries each person's most-recent visible thread", async () => {
  const source = await runnerSource();
  // Picks the newest visible thread per person so the menu can open straight
  // into the conversation; null when the favourite has no active thread.
  assert.match(source, /latestThreadByPerson/);
  assert.match(source, /threadId: latestThreadByPerson\.get\(person\.id\)\?\.threadId \?\? null/);
  // Response shape the desktop menu consumes.
  assert.match(source, /id: person\.id/);
  assert.match(source, /name: person\.displayName/);
});
