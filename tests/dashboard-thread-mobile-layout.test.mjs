import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// #896: mobile thread is a fixed four-row screen; only the message
// timeline scrolls. Pinned as source invariants (same approach as
// dashboard-thread-page-safety.test.mjs).
const threadSrc = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);
const briefSrc = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/thread/ThreadBriefBand.tsx", import.meta.url)),
  "utf8"
);

test("chat column owns overflow and is a fixed flex column", () => {
  assert.match(
    threadSrc,
    /data-testid="thread-chat-column"[\s\S]{0,120}className="relative flex h-full min-h-0 flex-col overflow-hidden/
  );
  assert.match(
    threadSrc,
    /className="relative grid h-full min-h-0 grid-cols-1 overflow-hidden/
  );
});

test("header and reply brief are layout rows outside the message scroller", () => {
  assert.match(threadSrc, /data-testid="thread-header-band"/);
  assert.match(threadSrc, /data-testid="thread-brief-row"/);
  assert.match(threadSrc, /data-testid="thread-message-timeline"/);

  const headerIdx = threadSrc.indexOf('data-testid="thread-header-band"');
  const briefIdx = threadSrc.indexOf('data-testid="thread-brief-row"');
  const timelineIdx = threadSrc.indexOf('data-testid="thread-message-timeline"');
  const composerIdx = threadSrc.indexOf('data-testid="thread-composer-footer"');

  assert.ok(headerIdx > 0 && briefIdx > headerIdx, "header before brief");
  assert.ok(timelineIdx > briefIdx, "timeline after brief");
  assert.ok(composerIdx > timelineIdx, "composer after timeline");

  // Header band itself must not be sticky-inside-scroller.
  const headerBlock = threadSrc.slice(headerIdx, headerIdx + 280);
  assert.doesNotMatch(headerBlock, /sticky top-0/);
  assert.match(headerBlock, /shrink-0/);
});

test("only the message timeline is the chat column scroller", () => {
  assert.match(
    threadSrc,
    /data-testid="thread-message-timeline"[\s\S]{0,500}className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"/
  );
  // Header/brief must not reintroduce sticky-in-scroller for the contact bar.
  const timelineOpen = threadSrc.indexOf('data-testid="thread-message-timeline"');
  const timelineCloseApprox = threadSrc.indexOf('data-testid="thread-composer-footer"');
  const timelineBody = threadSrc.slice(timelineOpen, timelineCloseApprox);
  assert.doesNotMatch(
    timelineBody,
    /data-testid="thread-header-band"/,
    "header band must not sit inside the timeline scroller"
  );
  assert.doesNotMatch(
    timelineBody,
    /data-testid="thread-brief-row"/,
    "brief row must not sit inside the timeline scroller"
  );
});

test("composer textarea caps height to min(160px, 28dvh) with internal scroll", () => {
  assert.match(threadSrc, /maxHeight:\s*"min\(160px,\s*28dvh\)"/);
  assert.match(threadSrc, /data-testid="thread-composer-input"/);
  assert.match(
    threadSrc,
    /className="block w-full resize-none overflow-y-auto border-0 bg-transparent/
  );
});

test("jump-to-latest is anchored to the composer footer, not the browser viewport", () => {
  const footerIdx = threadSrc.indexOf('data-testid="thread-composer-footer"');
  const jumpIdx = threadSrc.indexOf('data-testid="jump-to-latest"');
  assert.ok(footerIdx > 0 && jumpIdx > footerIdx);
  const between = threadSrc.slice(footerIdx, jumpIdx + 500);
  assert.match(between, /absolute -top-12 left-1\/2/);
  assert.doesNotMatch(between, /\bfixed\b/);
});

test("scroll restoration probes the message viewport, not a sticky header band", () => {
  assert.match(threadSrc, /const topInset = 8/);
  assert.doesNotMatch(threadSrc, /const stickyBand = 80/);
  // Focused realign must clear sticky focused-thread pill (top-2 + ~28–36px),
  // not tuck the parent under it. Require clearance ≥ pill coverage.
  const offsetMatch = threadSrc.match(/const FOCUS_HEADER_OFFSET\s*=\s*(\d+)/);
  assert.ok(offsetMatch, "FOCUS_HEADER_OFFSET must be a numeric constant");
  assert.ok(
    Number(offsetMatch[1]) >= 40,
    `FOCUS_HEADER_OFFSET must clear sticky focused pill (≥40px), got ${offsetMatch[1]}`
  );
  assert.match(threadSrc, /data-focused-pill="true"/);
  assert.match(threadSrc, /sticky top-2/);
  assert.match(threadSrc, /pickScrollAnchor/);
  assert.match(threadSrc, /restoreScrollRef/);
  assert.match(threadSrc, /startPostLoadAnchorGuard/);
});

test("mobile reply brief is compact with a disclosure for deeper context", () => {
  assert.match(briefSrc, /data-testid="thread-brief-expand"/);
  assert.match(briefSrc, /More context/);
  assert.match(briefSrc, /hidden sm:block/);
  assert.match(briefSrc, /sm:hidden/);
  assert.match(briefSrc, /To address/);
  assert.match(briefSrc, /Reply job/);
});

// F1: collapsed lead/loops clamp on mobile only. Expand is sm:hidden, so
// clamp must clear at sm+ (line-clamp-2 sm:line-clamp-none). Never clamp
// without a control at that breakpoint.
test("collapsed lead uses mobile-only clamp pattern", () => {
  assert.match(
    briefSrc,
    /line-clamp-2 sm:line-clamp-none/,
    "lead and loops must clear clamp at sm+ where expand is hidden"
  );
  // Lead span must not use unconditional line-clamp-2 (desktop hole).
  assert.doesNotMatch(
    briefSrc,
    /expanded\s*\?\s*["'`]["'`]\s*:\s*["'`]line-clamp-2["'`]/,
    "lead must not use bare line-clamp-2 without sm:line-clamp-none"
  );
  assert.match(briefSrc, /data-testid="thread-brief-expand"/);
  assert.match(briefSrc, /sm:hidden/, "expand control is mobile-only");
});

// Disclosure when expand actually reveals something: hidden context, or
// lead/loops that overflow their two-line clamp. Must measure rendered
// overflow (scrollHeight vs clientHeight), not guess via lead.length.
test("mobile brief offers expand from measured overflow, not char count", () => {
  assert.doesNotMatch(
    briefSrc,
    /hasDisclosure\s*=\s*showContext\s*\|\|\s*loops\.length\s*>\s*2\s*;/,
    "old hasDisclosure silently clamped long leads with few loops"
  );
  assert.doesNotMatch(
    briefSrc,
    /hasDisclosure\s*=\s*Boolean\(lead\)\s*\|\|\s*loops\.length\s*>\s*0/,
    "disclosure must not be always-on for every non-empty band"
  );
  assert.doesNotMatch(
    briefSrc,
    /lead\.length\s*>\s*\d+/,
    "must not guess overflow from character count"
  );
  assert.doesNotMatch(
    briefSrc,
    /hasDisclosure\s*=\s*\n?\s*showContext\s*\|\|\s*loops\.length\s*>\s*0/,
    "loops.length alone can show a no-op disclosure"
  );
  assert.match(
    briefSrc,
    /scrollHeight\s*>\s*.*clientHeight/,
    "disclosure must compare scrollHeight vs clientHeight after layout"
  );
  assert.match(
    briefSrc,
    /hasDisclosure\s*=\s*showContext\s*\|\|\s*leadOverflows\s*\|\|\s*loopsOverflows/,
    "disclosure when context is hidden or measured clamp overflow"
  );
  assert.match(briefSrc, /ResizeObserver/, "re-measure on width changes");
});

// Expanded state must not carry across thread navigations (30dvh surprise).
test("mobile brief resets expanded state when thread changes", () => {
  assert.match(
    briefSrc,
    /useEffect\(\s*\(\)\s*=>\s*\{\s*setExpanded\(false\)\s*;\s*\}\s*,\s*\[\s*threadId\s*\]\s*\)/,
    "expanded resets on threadId change"
  );
  assert.match(
    threadSrc,
    /<ThreadBriefBand[\s\S]{0,120}key=\{threadId\}/,
    "ThreadBriefBand remounts per thread via key"
  );
  assert.match(
    threadSrc,
    /threadId=\{threadId\}/,
    "ThreadBriefBand receives threadId for expand reset"
  );
});

// F2: expanded brief is a shrink-0 layout row; without a height cap it can
// crush the message timeline on short phones.
test("expanded mobile brief is height-capped with internal scroll", () => {
  assert.match(briefSrc, /max-h-\[30dvh\]/);
  assert.match(
    briefSrc,
    /expanded\s*\?\s*["'`][^"'`]*max-h-\[30dvh\][^"'`]*overflow-y-auto/
  );
});

test("desktop rails remain separate grid columns behind breakpoints", () => {
  assert.match(
    threadSrc,
    /lg:\[grid-template-columns:var\(--thread-cols-lg\)\]/
  );
  assert.match(
    threadSrc,
    /xl:\[grid-template-columns:var\(--thread-cols-xl\)\]/
  );
  assert.match(threadSrc, /hidden h-full min-h-0 flex-col overflow-y-auto border-r[\s\S]*?lg:flex/);
});
