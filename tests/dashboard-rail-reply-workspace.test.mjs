import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Issue #388. The thread right rail was reorganised from a reference
// panel into a reply workspace: lead with the action (Reply job), then
// supporting evidence (They said), then validation (Draft coverage),
// with the narrative summary (Where it stands) demoted below. The
// dashboard has no jsdom harness, so we pin the structure by asserting
// the order of the section markers in the component source — enough to
// catch an accidental reordering or a regression that buries Draft
// coverage back inside the "More" disclosure.

const PANEL = fileURLToPath(
  new URL("../apps/dashboard/components/thread/ReplyBriefPanel.tsx", import.meta.url)
);

// Strip comments so the section markers match the rendered JSX, not the
// explanatory comments / doc block (which also name the sections).
const source = readFileSync(PANEL, "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\/[^\n]*/g, "");

const idx = (needle) => {
  const i = source.indexOf(needle);
  assert.notEqual(i, -1, `expected to find ${needle} in ReplyBriefPanel.tsx`);
  return i;
};

test("rail leads with Reply job, then They said, then Draft coverage, then Where it stands (#388)", () => {
  const replyJob = idx("Reply job");
  const theySaid = idx("They said");
  const draftCoverage = idx('data-demo-target="reply-brief-draft-coverage"');
  const whereItStands = idx("Where it stands");

  assert.ok(replyJob < theySaid, "Reply job must come before They said");
  assert.ok(theySaid < draftCoverage, "They said must come before Draft coverage");
  assert.ok(
    draftCoverage < whereItStands,
    "Draft coverage must come before the demoted Where it stands"
  );
});

test("Reply job is sourced from on_you (keeps the reply-brief-on-you anchor)", () => {
  // Reuses brief.on_you per #388 — no new AI field. The data anchor is
  // preserved so the pilot tour / demo still target the same content.
  const anchor = idx('data-demo-target="reply-brief-on-you"');
  const replyJob = idx("Reply job");
  // The "Reply job" label sits inside the on_you-anchored block.
  assert.ok(replyJob > anchor, "Reply job label should render inside the on_you block");
});

test("Draft coverage uses the existing checklist and sits OUTSIDE the More disclosure (#388)", () => {
  const checklistUsages = source.split("<ActionItemsChecklist").length - 1;
  assert.equal(
    checklistUsages,
    1,
    "the checklist should be rendered exactly once (as Draft coverage), not duplicated"
  );
  const checklist = idx("<ActionItemsChecklist");
  const moreDisclosure = idx("{MORE_DISCLOSURE_LABEL}");
  assert.ok(
    checklist < moreDisclosure,
    "Draft coverage (the checklist) must render above/outside the More disclosure"
  );
});

test("Draft coverage is gated so reconnect / no-open-loop threads hide it cleanly (#388)", () => {
  // The section is wrapped in a showDraftCoverage gate; when there are no
  // required points and nothing dismissed, shouldShowChecklist returns
  // false and the section renders nothing.
  assert.match(source, /showDraftCoverage \? \(/);
  assert.match(source, /const showDraftCoverage = shouldShowChecklist\(/);
});
