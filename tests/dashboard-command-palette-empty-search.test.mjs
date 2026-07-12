import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/dashboard/components/layout/command-palette.tsx", import.meta.url),
  "utf8"
);

test("command palette describes conversation search without implying a contact directory", () => {
  assert.match(source, /Search conversations, pages, or actions/);
  assert.match(source, /A contact appears after a conversation is synced/);
  assert.doesNotMatch(source, /Search people, pages, or threads/);
});
