import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/dashboard/app/archived/page.tsx", import.meta.url),
  "utf8"
);

test("Archived describes only the explicit archive contract", () => {
  assert.match(source, /Threads you archive land here/);
  assert.match(source, /Only threads you archive appear here/);
  assert.doesNotMatch(source, /Handled|Snoozed|Ghosted|go cold|mark as handled/);
  assert.doesNotMatch(source, /archiveOutcome|lastMessageDirection === "OUT"/);
});

test("Archived failures are recoverable and never masquerade as an empty archive", () => {
  assert.match(source, /loading && error/);
  assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(source, />\s*Try again\s*</);
});

test("Archived selection is a sibling of thread navigation", () => {
  const row = source.slice(source.indexOf("function ArchivedRowItem"));
  assert.match(row, /<button[\s\S]*?<\/button>[\s\S]*?<Link/);
  assert.doesNotMatch(row, /<Link[\s\S]*?<button/);
});
