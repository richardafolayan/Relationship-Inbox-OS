import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODAL = readFileSync(
  join(ROOT, "apps/dashboard/components/common/pilot-feedback-modal.tsx"),
  "utf8"
);

test("pilot feedback uses a full-height mobile sheet with fixed header and footer", () => {
  assert.match(
    MODAL,
    /data-pilot-feedback-header="true"/,
    "form chrome must expose a fixed header marker"
  );
  assert.match(
    MODAL,
    /data-pilot-feedback-footer="true"/,
    "form chrome must expose a fixed footer marker so Submit stays visible with the keyboard open"
  );
  assert.match(
    MODAL,
    /className="flex shrink-0 items-center gap-3 border-b border-hairline/,
    "the feedback header must not shrink into the scroll area"
  );
  assert.match(
    MODAL,
    /data-pilot-feedback-footer="true"[\s\S]*shrink-0/,
    "the feedback footer must not shrink into the scroll area"
  );
  assert.match(
    MODAL,
    /h-\[100dvh\]|100dvh/,
    "phone layout must fill the dynamic viewport height"
  );
  assert.match(
    MODAL,
    /visualViewport/,
    "sheet height must track the visual viewport so Cancel/Submit stay above the soft keyboard"
  );
});

test("only the form body and reports list scroll", () => {
  const formScroll = MODAL.match(/data-pilot-feedback-scroll="form"/g);
  const reportsScroll = MODAL.match(/data-pilot-feedback-scroll="reports"/g);
  assert.equal(formScroll?.length, 1, "form view needs exactly one scroll region");
  assert.equal(reportsScroll?.length, 1, "reports view needs exactly one scroll region");

  assert.equal(
    (MODAL.match(/min-h-0 flex-1 overflow-y-auto/g) || []).length,
    2,
    "both views need shrinkable overflow-y-auto panes so tall content keeps chrome reachable"
  );
});

test("Cancel and Submit remain in fixed chrome, not only inside the scroller", () => {
  assert.match(MODAL, />\s*Cancel\s*</, "header exposes Cancel to close without scrolling");
  assert.match(
    MODAL,
    /data-pilot-feedback-submit="header"/,
    "header Submit stays visible while typing on phone"
  );
  assert.match(
    MODAL,
    /data-pilot-feedback-submit="footer"/,
    "footer Submit report stays visible above the bottom safe area"
  );
  // Submit must not live only inside the scroll pane.
  const formScrollBlock = MODAL.match(
    /data-pilot-feedback-scroll="form"[\s\S]*?data-pilot-feedback-footer/
  )?.[0];
  assert.ok(formScrollBlock, "form scroll region ends before the footer");
  assert.doesNotMatch(
    formScrollBlock,
    /data-pilot-feedback-submit/,
    "submit controls belong in fixed chrome, not the scrolling body"
  );
});

test("report type pills reflow in a two-column grid on phone", () => {
  assert.match(
    MODAL,
    /data-pilot-feedback-types="true"/,
    "type chooser is marked for layout tests"
  );
  assert.match(
    MODAL,
    /grid grid-cols-2/,
    "phone type pills use a 2-column grid instead of cramped wrap"
  );
  assert.match(
    MODAL,
    /PILOT_REPORT_TYPE_SHORT_LABELS/,
    "pills use short labels (Broken, Confusing, Feedback, Idea)"
  );
});

test("screenshot attachment prefers phone Photos/Files, keeps desktop drag", () => {
  assert.match(
    MODAL,
    /data-pilot-feedback-add-screenshot="true"/,
    "add-screenshot control is marked"
  );
  assert.match(
    MODAL,
    /Add from Photos or Files/,
    "phone CTA opens Photos, Camera or Files rather than drag-and-drop as the primary instruction"
  );
  assert.match(
    MODAL,
    /Drag screenshots here, or choose files/,
    "desktop still offers drag-and-drop"
  );
  assert.match(
    MODAL,
    /data-pilot-feedback-file-input="true"/,
    "native file input powers the phone picker"
  );
  assert.match(
    MODAL,
    /ALLOWED_SCREENSHOT_TYPES/,
    "file input still validates against allowed screenshot types"
  );
  assert.match(
    MODAL,
    /image\/\*/,
    "file input accepts image/* so phone Photos/Camera appear"
  );
});

test("recent reports prioritise user-facing status over internal ids", () => {
  assert.match(
    MODAL,
    /formatPilotReportStatus/,
    "status rows go through the user-facing status helper"
  );
  assert.match(
    MODAL,
    /formatPilotReportSubmittedAt/,
    "dates render as Submitted <day month>"
  );
  assert.match(
    MODAL,
    /Status: \{statusLabel\}/,
    "primary row shows Status: <label>"
  );
  assert.match(
    MODAL,
    /Received, Under\s+review, Planned, Fixed, or Closed/,
    "reports screen explains what status represents"
  );
  assert.match(
    MODAL,
    /Ref: \{report\.reportId\}/,
    "internal report ids stay secondary metadata, not the main row emphasis"
  );
  assert.doesNotMatch(
    MODAL,
    /font-mono text-\[10\.5px\] uppercase tracking-\[0\.06em\][\s\S]{0,40}\{report\.reportId\}/,
    "report id is no longer a mono uppercase primary badge"
  );
});

test("feedback never auto-includes private message content", () => {
  assert.match(
    MODAL,
    /Please don't paste private message content/,
    "details field warns against pasting private messages"
  );
  assert.match(
    MODAL,
    /No message content is included unless you attach it/,
    "footer restates that message content is not auto-included"
  );
  assert.match(
    MODAL,
    /Private message content and\s+screenshots are never shown here/,
    "recent reports view does not surface message content"
  );
});

test("failed feedback remains visible and retryable", () => {
  assert.match(MODAL, /data-pilot-feedback-error="true"/);
  assert.match(MODAL, /Your details are still here, so you can try again/);
  assert.match(MODAL, /submittingRef\.current/);
  assert.match(MODAL, /Sending report\.\.\./);
});

test("back and close behaviour is explicit", () => {
  assert.match(MODAL, />\s*Back\s*</, "reports view has Back to the form");
  assert.match(MODAL, />\s*Close\s*</, "reports view has Close");
  assert.match(MODAL, />\s*Cancel\s*</, "form view has Cancel");
  assert.match(MODAL, /Escape/, "Escape closes the overlay");
  assert.match(
    MODAL,
    /document\.body\.style\.overflow = "hidden"/,
    "open sheet locks background scroll"
  );
});
