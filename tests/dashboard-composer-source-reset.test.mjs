import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { composerSourceAfterClear, showsPredraftFrame } = await import(
  "../apps/dashboard/lib/composer-source.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "app", "thread", "[id]", "page.tsx"),
  "utf8"
);

// --- Pure derivations -------------------------------------------------------

test("clearing the composer always returns the source to empty", () => {
  assert.equal(composerSourceAfterClear(), "empty");
});

test("the predraft frame shows only with predraft source AND text present", () => {
  assert.equal(showsPredraftFrame("predraft", "Hi there"), true);
  // A stale "predraft" source over an emptied composer must NOT wear the frame.
  assert.equal(showsPredraftFrame("predraft", ""), false);
  assert.equal(showsPredraftFrame("predraft", "   "), false);
  assert.equal(showsPredraftFrame("user", "Hi there"), false);
  assert.equal(showsPredraftFrame("draft", "Hi there"), false);
  assert.equal(showsPredraftFrame("empty", ""), false);
});

// --- Send/schedule reset race ----------------------------------------------
// The thread page does NOT remount across a same-thread send. `composerSource`
// is a single piece of state. Model the page lifecycle the way
// dashboard-suggestions-spinner.test.mjs models the spinner flag: a send or a
// schedule that empties the composer must also reset the source, or the
// AI-predraft badge/frame keeps framing a now-empty input.

function makeComposerModel() {
  let composerText = "";
  let composerSource = "empty";

  return {
    loadPredraft(text) {
      composerText = text;
      composerSource = "predraft";
    },
    // onSend / scheduleSend optimistic-clear after the bug fix: clear the text
    // AND reset the source via the helper.
    clearAfterSend() {
      composerText = "";
      composerSource = composerSourceAfterClear();
    },
    badgeVisible() {
      // Mirrors the render predicate (composerSource === "predraft").
      return composerSource === "predraft";
    },
    text() {
      return composerText;
    }
  };
}

test("sending an AI predraft on the same thread drops the predraft badge", () => {
  const page = makeComposerModel();

  page.loadPredraft("Thanks, that works for me.");
  assert.equal(page.badgeVisible(), true, "predraft shows the badge while it has text");

  page.clearAfterSend();
  assert.equal(page.text(), "", "composer is emptied after send");
  // Before the fix composerSource stayed "predraft" here and this failed: the
  // badge + accent frame framed an empty input until the operator typed.
  assert.equal(page.badgeVisible(), false, "badge is gone once the predraft is sent");
});

// --- Static-source regression ----------------------------------------------
// The handlers' JSX cannot be unit-mounted here, so guard the fix in place the
// same way dashboard-thread-page-state-race-guards.test.mjs does: both onSend
// and scheduleSend MUST reset composerSource right after clearing the text.
// These fail before the fix (the reset line is absent) and pass after.

const RESET =
  /setComposerSource\(composerSourceAfterClear\(\)\)|setComposerSource\("empty"\)|setComposerSource\(clearedIntent\.source\)/;

test("onSend resets composerSource after clearing the composer", () => {
  // The optimistic clear sits just before setComposerAttachments([]) (the only
  // occurrence in the file), so scan the window leading up to it.
  const anchor = SRC.indexOf("setComposerAttachments([]);");
  assert.notEqual(anchor, -1, "located the onSend optimistic-clear block");
  const block = SRC.slice(anchor - 700, anchor + 30);
  assert.match(block, /setComposer\(""\);/, "onSend clears the composer text");
  assert.match(
    block,
    RESET,
    "onSend must reset composerSource so the predraft badge does not frame an empty composer"
  );
});

test("an accepted scheduled send resets composerSource when it clears the composer", () => {
  const start = SRC.indexOf("const clearCapturedComposerAfterAcceptedAction = useCallback(");
  const end = SRC.indexOf("// Send-queue polling fallback", start);
  assert.notEqual(start, -1, "located accepted-action composer cleanup");
  assert.notEqual(end, -1, "located the end of accepted-action composer cleanup");
  const block = SRC.slice(start, end);
  assert.match(block, /setComposer\(""\);/, "accepted scheduled send clears the composer text");
  assert.match(
    block,
    RESET,
    "accepted scheduled send must reset composerSource so the predraft badge does not frame an empty composer"
  );
  assert.match(
    SRC,
    /disposition === "scheduled" && pending\.attemptKind === "scheduled"[\s\S]*?clearCapturedComposerAfterAcceptedAction\(pending\)/,
    "the scheduled status path must use the accepted-action cleanup"
  );
});
