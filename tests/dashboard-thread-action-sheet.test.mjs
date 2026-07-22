import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// action-sheet-gesture.ts is framework-free; tsx resolves the .ts import
// (same pattern as dashboard-toast-gesture.test.mjs).
const { SHEET_SWIPE_DISMISS_PX, shouldDismissSheetSwipe } = await import(
  "../apps/dashboard/lib/action-sheet-gesture.ts"
);

// Issue #901. Phone thread overflow must use a bottom action sheet with
// grouped actions, while desktop keeps the popover Menu. Source-contract
// tests pin the responsive split, dismissal, focus restore, and scroll lock
// because the dashboard has no jsdom harness for the thread page.

const threadPage = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);
const actionSheet = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/ui/action-sheet.tsx", import.meta.url)),
  "utf8"
);
const button = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/ui/button.tsx", import.meta.url)),
  "utf8"
);
const globals = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/globals.css", import.meta.url)),
  "utf8"
);

test("swipe-down past the threshold dismisses the action sheet (#901)", () => {
  assert.equal(shouldDismissSheetSwipe(0), false);
  assert.equal(shouldDismissSheetSwipe(SHEET_SWIPE_DISMISS_PX - 1), false);
  assert.equal(shouldDismissSheetSwipe(SHEET_SWIPE_DISMISS_PX), true);
  assert.equal(shouldDismissSheetSwipe(SHEET_SWIPE_DISMISS_PX + 40), true);
  // Quick flick: half travel + velocity also dismisses.
  assert.equal(shouldDismissSheetSwipe(SHEET_SWIPE_DISMISS_PX / 2, 0.6), true);
  assert.equal(shouldDismissSheetSwipe(SHEET_SWIPE_DISMISS_PX / 2, 0.1), false);
  // Upward or negative travel never dismisses.
  assert.equal(shouldDismissSheetSwipe(-20, 1), false);
});

test("phone uses ActionSheet; desktop/tablet keeps Menu popover (#901)", () => {
  assert.match(threadPage, /import \{ ActionSheet, type ActionSheetGroup \} from "@\/components\/ui\/action-sheet"/);
  assert.match(threadPage, /compactActions \? \(/);
  assert.match(threadPage, /data-testid="thread-overflow-trigger"/);
  assert.match(threadPage, /<ActionSheet/);
  assert.match(threadPage, /title="Thread actions"/);
  assert.match(threadPage, /historyKey="threadOverflow"/);
  // Desktop path still mounts the existing popover Menu.
  assert.match(threadPage, /<Menu[\s\S]*items=\{overflowMenuItems\}/);
  assert.match(threadPage, /overflowMenuItems = \[/);
});

test("touch-only iOS keeps phone composer controls even with a desktop-width viewport", () => {
  assert.match(threadPage, /\(max-width: 767px\), \(hover: none\) and \(pointer: coarse\)/);
  assert.match(threadPage, /desktop-ui-flex mt-1\.5 flex-wrap items-center gap-2/);
  assert.match(threadPage, /phone-ui-flex mt-1\.5 items-center gap-2/);
  assert.match(globals, /@media \(min-width: 768px\) and \(hover: hover\) and \(pointer: fine\)/);
  assert.match(globals, /\.phone-ui-flex \{ display: flex; \}/);
  assert.match(globals, /\.desktop-ui-flex \{ display: flex; \}/);
});

test("action sheet groups Primary, Conversation tools, and External (#901)", () => {
  assert.match(threadPage, /id: "primary"/);
  assert.match(threadPage, /label: "Primary"/);
  assert.match(threadPage, /id: "conversation"/);
  assert.match(threadPage, /label: "Conversation tools"/);
  assert.match(threadPage, /id: "external"/);
  assert.match(threadPage, /label: "External"/);
  assert.match(threadPage, /saveDraftAction/);
  assert.match(threadPage, /snoozeOverflowAction/);
  assert.match(threadPage, /archiveOverflowAction/);
  assert.match(threadPage, /remindOverflowAction/);
  assert.match(threadPage, /reassessOverflowAction/);
  assert.match(threadPage, /rescanOverflowAction/);
  assert.match(threadPage, /openInPlatformAction/);
  assert.match(threadPage, /receiptsOverflowAction/);
  // Disruptive archive is confirmed and danger-styled.
  assert.match(threadPage, /window\.confirm\(/);
  assert.match(threadPage, /danger: !thread\.archivedAt/);
});

test("action sheet has title, close, handle, safe area, and internal scroll (#901)", () => {
  assert.match(actionSheet, /data-testid="thread-action-sheet"/);
  assert.match(actionSheet, /data-testid="thread-action-sheet-close"/);
  assert.match(actionSheet, /data-testid="thread-action-sheet-handle"/);
  assert.match(actionSheet, /data-testid="thread-action-sheet-body"/);
  assert.match(actionSheet, /data-testid="thread-action-sheet-backdrop"/);
  assert.match(actionSheet, /role="dialog"/);
  assert.match(actionSheet, /aria-modal="true"/);
  assert.match(actionSheet, /pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.match(actionSheet, /maxHeight: "min\(calc\(var\(--app-vv-height, 100vh\) \* 0\.78\), 640px\)"/);
  assert.match(actionSheet, /top: "var\(--app-vv-offset-top, 0px\)"/);
  assert.match(actionSheet, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(actionSheet, /phone-ui-flex fixed/);
});

test("action sheet locks thread scroll and restores message position (#901)", () => {
  assert.match(actionSheet, /scrollLockTargetRef/);
  assert.match(actionSheet, /target\.style\.overflow = "hidden"/);
  assert.match(actionSheet, /target\.scrollTop = scrollTopRef\.current/);
  assert.match(actionSheet, /document\.body\.style\.overflow = "hidden"/);
  assert.match(threadPage, /scrollLockTargetRef=\{timelineRef\}/);
});

test("Escape, Back, backdrop, and close control dismiss the sheet (#901)", () => {
  assert.match(actionSheet, /event\.key !== "Escape"/);
  assert.match(actionSheet, /stopImmediatePropagation\(\)/);
  assert.match(actionSheet, /addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(actionSheet, /history\.pushState\(\{ \[historyKey\]: true \}/);
  assert.match(actionSheet, /popstate/);
  assert.match(actionSheet, /history\.back\(\)/);
  assert.match(actionSheet, /requestClose/);
  assert.match(actionSheet, /onTouchEnd/);
  assert.match(actionSheet, /shouldDismissSheetSwipe/);
});

test("closing restores focus to the overflow trigger (#901)", () => {
  assert.match(actionSheet, /returnFocusRef/);
  assert.match(actionSheet, /returnTo\.focus\(\)/);
  assert.match(actionSheet, /closeButtonRef\.current\?\.focus/);
  assert.match(threadPage, /returnFocusRef=\{overflowTriggerRef\}/);
  assert.match(threadPage, /overflowTriggerRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(button, /forwardRef/);
});
