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

test("compose draft and ask answer live in the scroll middle, not the fixed footer (#898 F1)", () => {
  // Results must be reachable under overlay body lock: they belong in the
  // flex-1 overflow-y-auto region, not the shrink-0 action strip.
  const middleStart = threadPage.indexOf('min-h-0 flex-1 overflow-y-auto overscroll-contain');
  const footerStart = threadPage.indexOf(
    'shrink-0 border-t border-hairline bg-paper px-5 pt-3 pb-[calc(24px+env(safe-area-inset-bottom))]'
  );
  assert.ok(middleStart >= 0, "scroll middle region present");
  assert.ok(footerStart > middleStart, "footer follows scroll middle");
  const middle = threadPage.slice(middleStart, footerStart);
  // Footer runs until the aside closes.
  const asideClose = threadPage.indexOf("</aside>", footerStart);
  const footer = threadPage.slice(footerStart, asideClose > footerStart ? asideClose : footerStart + 12000);
  assert.match(middle, /data-testid="ai-assist-compose-draft"/);
  assert.match(middle, /data-testid="ai-assist-ask-answer"/);
  assert.match(middle, /\{composeDraft \?/);
  assert.match(middle, /\{askAnswer \?/);
  assert.doesNotMatch(footer, /data-testid="ai-assist-compose-draft"/);
  assert.doesNotMatch(footer, /data-testid="ai-assist-ask-answer"/);
  // Footer still holds intent + primary action.
  assert.match(footer, /value=\{composeIntent\}/);
  assert.match(footer, /composeFromIntent\(\)/);
});

test("phone overlay sizes from visualViewport height so footer stays above keyboard (#898 F2)", () => {
  assert.match(threadPage, /window\.visualViewport/);
  assert.match(threadPage, /vv\.addEventListener\("resize"/);
  assert.match(threadPage, /vv\.addEventListener\("scroll"/);
  assert.match(threadPage, /orientationchange/);
  // Pin the panel box to the visual viewport (not only a bottom inset).
  assert.match(threadPage, /panel\.style\.top/);
  assert.match(threadPage, /panel\.style\.height/);
  assert.match(threadPage, /panel\.style\.maxHeight/);
  assert.match(threadPage, /panel\.style\.bottom = "auto"/);
  assert.match(threadPage, /vv\.offsetTop/);
  assert.match(threadPage, /vv\.height/);
  // Must not rely on bottom-inset-only math as the sole keyboard strategy.
  assert.doesNotMatch(
    threadPage,
    /innerHeight - vv\.height - vv\.offsetTop/
  );
  assert.match(threadPage, /scrollIntoView/);
  // Cleanup restores fixed inset-0 classes.
  assert.match(threadPage, /panel\.style\.top = ""/);
  assert.match(threadPage, /panel\.style\.height = ""/);
  assert.match(threadPage, /panel\.style\.bottom = ""/);
});

test("phone AI history always pops on unmount and intercepts in-panel nav (#898 F3)", () => {
  // Cleanup must always history.back when we pushed, not only when
  // history.state still has aiAssist (Settings nav clears that state).
  assert.match(threadPage, /aiHistoryPushedRef\.current = true/);
  assert.match(threadPage, /window\.history\.back\(\)/);
  // Must not gate the unmount pop solely on state?.aiAssist.
  assert.doesNotMatch(
    threadPage,
    /if \(state\?\.aiAssist\) \{\s*window\.history\.back\(\)/
  );
  // In-panel links pop the synthetic entry before navigating.
  assert.match(threadPage, /onNavClickCapture/);
  assert.match(threadPage, /closest\?\.\("a\[href\]"\)/);
  assert.match(threadPage, /router\.push\(path\)/);
});

test("close, Escape, and swipe-back only consume the synthetic history entry (#898 F4)", () => {
  // Synthetic entry is marked and only popped while the ref is set.
  assert.match(threadPage, /history\.pushState\(\{ aiAssist: true \}/);
  assert.match(threadPage, /aiHistoryPushedRef\.current = true/);
  // Swipe-back: ignore popstate once the ref is cleared (no second back).
  assert.match(
    threadPage,
    /const onPopState = \(\) => \{\s*if \(!aiHistoryPushedRef\.current\) return;/
  );
  // Close button / Escape / unmount: history.back only when we still own the entry.
  assert.match(
    threadPage,
    /if \(aiHistoryPushedRef\.current\) \{\s*aiHistoryPushedRef\.current = false;\s*window\.history\.back\(\)/
  );
  // In-panel nav clears the ref before back so onPopState does not also fire close.
  const navBlockStart = threadPage.indexOf("onNavClickCapture");
  assert.ok(navBlockStart >= 0, "in-panel nav capture present");
  const navBlock = threadPage.slice(navBlockStart, navBlockStart + 1800);
  assert.match(navBlock, /aiHistoryPushedRef\.current = false/);
  assert.ok(
    navBlock.indexOf("aiHistoryPushedRef.current = false") <
      navBlock.indexOf("window.history.back()"),
    "in-panel nav must clear the push ref before history.back"
  );
});
