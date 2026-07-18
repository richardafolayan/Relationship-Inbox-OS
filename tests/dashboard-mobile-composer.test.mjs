import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level guards for issue #900: compact mobile composer with
// progressive disclosure, draft height cap, and unchanged desktop chrome.
const src = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);

test("mobile default exposes only + / dictate / Send primary actions", () => {
  assert.match(src, /data-testid="composer-mobile-actions"/);
  assert.match(src, /data-testid="composer-more-toggle"/);
  assert.match(src, /data-testid="composer-mobile-send"/);
  const mobileBlock = src.slice(
    src.indexOf('data-testid="composer-mobile-actions"'),
    src.indexOf('data-testid="composer-mobile-send"') + 80
  );
  assert.match(mobileBlock, /Plus/);
  assert.match(mobileBlock, /aria-label="Dictate"/);
  assert.match(mobileBlock, /Send/);
  assert.doesNotMatch(
    mobileBlock,
    /Suggested replies|shorten|Schedule send|Attach files|Record voice note/,
    "secondary labels must not sit in the mobile primary row"
  );
});

test("secondary mobile tools live behind the + sheet", () => {
  assert.match(src, /data-testid="composer-more-sheet"/);
  assert.match(src, /composerMoreOpen/);
  const sheetIdx = src.indexOf('data-testid="composer-more-sheet"');
  assert.notEqual(sheetIdx, -1);
  // Sheet runs until the desktop full toolbar comment.
  const sheetEnd = src.indexOf("Desktop full toolbar", sheetIdx);
  const sheetBlock = src.slice(sheetIdx, sheetEnd === -1 ? sheetIdx + 12000 : sheetEnd);
  assert.match(sheetBlock, /aria-label="Schedule send"/);
  assert.match(sheetBlock, /aria-label="Attach files"/);
  assert.match(sheetBlock, /aria-label=\{recording \? "Stop recording" : "Record voice note"\}/);
  assert.match(sheetBlock, /\n\s*Past context\n/);
  assert.match(sheetBlock, /\n\s*Schedule\n/);
  assert.match(sheetBlock, /\? "Stop voice note" : "Voice note"/);
  assert.doesNotMatch(sheetBlock, /Shorten|Warmer|SHORTEN|MAKE_WARMER/);
  assert.match(sheetBlock, /Suggested replies/);
  assert.match(src, /composerMoreOpen \? "flex" : "hidden md:flex"/);
});

test("draft textarea is capped at min(160px, 28dvh) with internal scroll", () => {
  assert.match(src, /maxHeight:\s*["']min\(160px,\s*28dvh\)["']/);
  assert.match(src, /overflow-y-auto/);
  assert.match(src, /window\.innerHeight[\s\S]*?\*\s*0\.28/);
});

test("AI predraft compresses on mobile with Edit and Discard", () => {
  const badgeIdx = src.indexOf('data-testid="ai-predraft-badge"');
  assert.notEqual(badgeIdx, -1);
  const badgeBlock = src.slice(badgeIdx, badgeIdx + 2000);
  assert.match(badgeBlock, />AI draft</);
  assert.match(badgeBlock, /\n\s*Edit\n/);
  assert.match(badgeBlock, /\n\s*Discard\n/);
  assert.match(badgeBlock, /composerInputRef\.current\?\.focus\(\)/);
  assert.match(badgeBlock, /md:hidden/);
});

test("desktop toolbar remains available at md+ and is not the mobile row", () => {
  assert.match(src, /hidden flex-wrap items-center gap-2 md:flex/);
  assert.match(src, /composer-mobile-actions"[\s\S]*?className="mt-1\.5 flex items-center gap-2 md:hidden"/);
});

test("thread switch closes the mobile more sheet", () => {
  const effectBodies = [
    ...src.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[threadId\]\)/g)
  ].map((m) => m[1]);
  const reset = effectBodies.find(
    (body) => body.includes('setComposer("")') && body.includes("setComposerMoreOpen(false)")
  );
  assert.ok(reset, "expected threadId reset to close composerMoreOpen");
});
