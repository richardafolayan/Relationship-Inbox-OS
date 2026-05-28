import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Issue #380 / pilot R-0028, residual fix. #410 fixed the summary/brief
// path so a single partial reply no longer flips the brief into RECONNECT
// framing. But the DRAFT generator (generateSuggestedReplies) still chose
// its mode from the same binary timestamp flag: operator's last message
// newer than the contact's → needsReply=false → "MODE: REOPEN" (generate
// conversation starters for a quiet thread). So after replying to one of
// several contact topics, the suggested replies stopped addressing the
// rest — exactly the "still have replies for the rest of stuff" complaint.
//
// selectSuggestedReplyMode is the fix: REOPEN only when the contact isn't
// waiting AND no reply debt remains. The debt signal is the #410 brief's
// required_points (handled/optional already excluded), with the legacy
// open_loops mirror as a cold-path fallback.

const AI_JS = fileURLToPath(new URL("../apps/runner/dist/services/ai.js", import.meta.url));
const { selectSuggestedReplyMode } = await import(AI_JS);

function briefWithRequired(texts) {
  return {
    where_it_stands: "",
    on_you: "",
    required_points: texts.map((text, i) => ({ id: `r${i}`, text, status: "required" })),
    optional_followups: [],
    handled_points: [],
    they_said: []
  };
}

test("contact is waiting (needsReply) → reply mode, regardless of brief", () => {
  assert.equal(selectSuggestedReplyMode({ needsReply: true, replyBrief: null, openLoops: [] }), "reply");
  assert.equal(
    selectSuggestedReplyMode({ needsReply: true, replyBrief: briefWithRequired([]), openLoops: [] }),
    "reply"
  );
});

test("#380 regression: partial reply with remaining required_points stays in reply mode", () => {
  // The bug case: operator replied to one topic so their message is newest
  // (needsReply=false), but the contact raised several distinct points and
  // the brief still lists the unaddressed ones. Must NOT flip to reopen.
  const mode = selectSuggestedReplyMode({
    needsReply: false,
    replyBrief: briefWithRequired([
      "Confirm the workshop timeline",
      "Answer the pricing question",
      "Reply about the venue change"
    ]),
    openLoops: []
  });
  assert.equal(mode, "reply");
});

test("cold path with no brief but open loops remain → reply mode (legacy mirror)", () => {
  const mode = selectSuggestedReplyMode({
    needsReply: false,
    replyBrief: null,
    openLoops: ["Confirm the timeline", "Answer pricing"]
  });
  assert.equal(mode, "reply");
});

test("genuinely quiet thread (no pending, no debt) → reopen mode", () => {
  assert.equal(
    selectSuggestedReplyMode({ needsReply: false, replyBrief: briefWithRequired([]), openLoops: [] }),
    "reopen"
  );
  // No brief at all and no open loops is the same quiet case.
  assert.equal(
    selectSuggestedReplyMode({ needsReply: false, replyBrief: null, openLoops: [] }),
    "reopen"
  );
});

test("handled points do not count as debt — operator covered everything → reopen", () => {
  // required_points carries only still-owed points (#410 drops handled
  // ones), so a brief whose remaining required list is empty means the
  // operator addressed everything; reaching back is appropriate.
  const brief = briefWithRequired([]);
  brief.handled_points = [{ id: "h0", text: "Answered the intro question", status: "handled" }];
  assert.equal(selectSuggestedReplyMode({ needsReply: false, replyBrief: brief, openLoops: [] }), "reopen");
});

test("whitespace-only points are not treated as reply debt → reopen", () => {
  const mode = selectSuggestedReplyMode({
    needsReply: false,
    replyBrief: briefWithRequired(["   ", ""]),
    openLoops: ["  "]
  });
  assert.equal(mode, "reopen");
});

test("generateSuggestedReplies selects its mode via selectSuggestedReplyMode, not a raw needsReply flip", () => {
  // Pin the wiring so a future edit can't reintroduce the binary
  // `input.needsReply ? REPLY : REOPEN` flip that caused the regression.
  const source = readFileSync(AI_JS, "utf8");
  assert.match(source, /selectSuggestedReplyMode\(/);
  assert.match(source, /replyMode === "reply"/);
});
