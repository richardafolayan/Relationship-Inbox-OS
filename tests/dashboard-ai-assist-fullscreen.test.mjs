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
const appShell = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/layout/app-shell.tsx", import.meta.url)),
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

test("Escape stops propagation so shell does not leave the thread (#898 F1)", () => {
  // AI handler must consume Escape in capture phase before app-shell bubble.
  assert.match(threadPage, /event\.stopImmediatePropagation\(\)/);
  assert.match(threadPage, /event\.stopPropagation\(\)/);
  assert.match(threadPage, /addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(threadPage, /removeEventListener\("keydown", onKeyDown, true\)/);
  // App-shell must also skip Esc→/today when Escape was already handled or a modal is open.
  assert.match(appShell, /event\.defaultPrevented/);
  assert.match(appShell, /aria-modal="true"/);
  assert.match(appShell, /router\.push\("\/today"\)/);
  // Gating must sit on the Escape path before the thread→today push.
  const escBlock = appShell.slice(
    appShell.indexOf('if (event.key === "Escape")'),
    appShell.indexOf('if (event.key === "[")')
  );
  assert.match(escBlock, /event\.defaultPrevented/);
  assert.match(escBlock, /aria-modal="true"/);
  assert.ok(
    escBlock.indexOf("defaultPrevented") < escBlock.indexOf('router.push("/today")'),
    "defaultPrevented gate must precede Esc→/today navigation"
  );
  assert.ok(
    escBlock.indexOf('aria-modal="true"') < escBlock.indexOf('router.push("/today")'),
    "aria-modal gate must precede Esc→/today navigation"
  );
});

test("overlay AI Assist traps Tab focus inside the dialog (#898 F2)", () => {
  assert.match(threadPage, /if \(!aiOpen \|\| !aiOverlayMode\) return/);
  assert.match(threadPage, /event\.key !== "Tab"/);
  assert.match(threadPage, /getElementById\("ai-assist-panel"\)/);
  assert.match(threadPage, /panel\.contains\(active\)/);
  assert.match(threadPage, /last\.focus\(\)/);
  assert.match(threadPage, /first\.focus\(\)/);
});

test("mobile AI Assist subordinates repeated brief context (#898)", () => {
  assert.match(threadPage, /subordinateContext=\{aiOverlayMode\}/);
  assert.match(replyBrief, /subordinateContext\?/);
  assert.match(replyBrief, /showWhereInMore/);
  assert.match(replyBrief, /showWhereInline/);
});
