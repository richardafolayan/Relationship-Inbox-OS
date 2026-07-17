import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Issue #898. AI Assist must present as a full-screen phone view, tablet
// slide-over, and desktop docked rail, with fixed header / scrollable
// context / keyboard-safe action area, background scroll lock, and
// Escape + Back close behaviour. The dashboard has no jsdom harness for
// the thread page, so we pin the responsive structure and interaction
// wiring by source contract.

const threadPage = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);
const replyBrief = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/thread/ReplyBriefPanel.tsx", import.meta.url)),
  "utf8"
);

test("phone AI Assist is full-screen; tablet keeps slide-over; desktop docks (#898)", () => {
  // Phone: covers the full app content area rather than leaving an 8% strip.
  assert.match(threadPage, /fixed inset-0 w-full/);
  assert.match(threadPage, /z-\[70\] flex min-h-0 flex-col bg-paper/);
  // Tablet: right-hand slide-over width.
  assert.match(threadPage, /sm:w-\[min\(92vw,380px\)\]/);
  assert.match(threadPage, /sm:left-auto sm:right-0/);
  // Desktop: docked rail (static in the grid).
  assert.match(threadPage, /xl:static xl:z-auto xl:h-full xl:w-auto/);
  // Old 92vw-only fixed rail must not remain as the only presentation.
  assert.doesNotMatch(
    threadPage,
    /fixed inset-y-0 right-0 z-40 w-\[min\(92vw,380px\)\] overflow-y-auto/
  );
});

test("AI Assist uses fixed header, scrollable context, keyboard-safe action area (#898)", () => {
  assert.match(threadPage, /data-testid="ai-assist-panel"/);
  assert.match(threadPage, /data-testid="ai-assist-close"/);
  // Scrollable interior (not the whole aside).
  assert.match(threadPage, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  // Keyboard-safe / safe-area action footer.
  assert.match(threadPage, /pb-\[calc\(24px\+env\(safe-area-inset-bottom\)\)\]/);
  // Header stays out of the scroll region (shrink-0 + close control).
  assert.match(threadPage, /flex shrink-0 items-center justify-between border-b border-hairline/);
  assert.match(threadPage, /shrink-0 border-t border-hairline bg-paper/);
});

test("overlay mode locks background scroll and restores on close (#898)", () => {
  assert.match(threadPage, /aiTimelineScrollRef/);
  assert.match(threadPage, /timeline\.style\.overflow = "hidden"/);
  assert.match(threadPage, /document\.body\.style\.overflow = "hidden"/);
  assert.match(threadPage, /timeline\.scrollTop = aiTimelineScrollRef\.current/);
});

test("Escape and phone Back close AI Assist; focus is managed (#898)", () => {
  assert.match(threadPage, /event\.key !== "Escape"/);
  assert.match(threadPage, /closeAiAssist\(\)/);
  assert.match(threadPage, /history\.pushState\(\{ aiAssist: true \}/);
  assert.match(threadPage, /popstate/);
  assert.match(threadPage, /aiCloseButtonRef\.current\?\.focus/);
  assert.match(threadPage, /aiReturnFocusRef/);
  assert.match(threadPage, /returnTo\.focus\(\)/);
});

test("mobile AI Assist subordinates repeated brief context (#898)", () => {
  assert.match(threadPage, /subordinateContext=\{aiOverlayMode\}/);
  assert.match(replyBrief, /subordinateContext\?/);
  assert.match(replyBrief, /showWhereInMore/);
  assert.match(replyBrief, /showWhereInline/);
});
