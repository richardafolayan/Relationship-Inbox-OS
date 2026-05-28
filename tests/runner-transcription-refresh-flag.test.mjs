import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { messageIdsAwaitingTranscriptRefresh } from "../apps/runner/dist/services/transcription/refresh-flag.js";

// Issue #385. PR #384 set MessageAudioTranscription.needsAiRefresh when a
// higher-tier / refined transcript replaced an earlier selection after a
// thread was already summarised, but nothing ever cleared it. The fix
// clears the flag inside resummarizeThreadById, transactionally with the
// summary write, on exactly the messages the summariser just consumed.
//
// Two layers of coverage:
//   1. Behavioural unit tests of the pure selector below.
//   2. Source-level wiring tests that pin the transactional clear in
//      index.ts (resummarizeThreadById is a module-scope function that
//      closes over prisma, so a behavioural test would need to boot
//      Express + mock prisma — the same trade-off taken in
//      runner-reassess-race-scope.test.mjs).

function msg(id, refreshFlag) {
  // refreshFlag === undefined models a message with no audio transcription.
  return {
    id,
    audioTranscription:
      refreshFlag === undefined ? null : { needsAiRefresh: refreshFlag }
  };
}

test("messageIdsAwaitingTranscriptRefresh: empty input → empty output", () => {
  assert.deepEqual(messageIdsAwaitingTranscriptRefresh([]), []);
});

test("messageIdsAwaitingTranscriptRefresh: skips messages with no transcription", () => {
  assert.deepEqual(
    messageIdsAwaitingTranscriptRefresh([msg("a"), msg("b")]),
    []
  );
});

test("messageIdsAwaitingTranscriptRefresh: skips transcriptions whose flag is already clear", () => {
  assert.deepEqual(
    messageIdsAwaitingTranscriptRefresh([msg("a", false), msg("b", false)]),
    []
  );
});

test("messageIdsAwaitingTranscriptRefresh: returns ids of flagged transcriptions", () => {
  assert.deepEqual(
    messageIdsAwaitingTranscriptRefresh([msg("a", true), msg("b", true)]),
    ["a", "b"]
  );
});

test("messageIdsAwaitingTranscriptRefresh: returns only flagged ids from a mixed list, in order", () => {
  const messages = [
    msg("none"), // no transcription
    msg("clear", false), // transcribed but caught up
    msg("stale-1", true), // upgraded since last summary
    msg("clear-2", false),
    msg("stale-2", true)
  ];
  assert.deepEqual(messageIdsAwaitingTranscriptRefresh(messages), [
    "stale-1",
    "stale-2"
  ]);
});

// ----- Source-level wiring (resummarizeThreadById lives in index.ts) -----

function resummarizeFnBody() {
  const indexTs = readFileSync(
    resolve(process.cwd(), "apps/runner/src/index.ts"),
    "utf8"
  );
  const match = indexTs.match(/async function resummarizeThreadById[\s\S]*?\n\}\n/);
  assert.ok(match, "resummarizeThreadById not found");
  return match[0];
}

test("resummarizeThreadById selects clear-targets from the messages it summarised", () => {
  // The flag clear must target the SAME message set the summariser
  // consumed (recentMessagesDesc) — not a re-fetch that could drift.
  assert.match(
    resummarizeFnBody(),
    /messageIdsAwaitingTranscriptRefresh\(\s*recentMessagesDesc\s*\)/,
    "resummarizeThreadById must derive clear-targets from recentMessagesDesc"
  );
});

test("resummarizeThreadById clears needsAiRefresh in the same transaction as the summary write", () => {
  // $transaction([summaryWrite, updateMany(... needsAiRefresh: false ...)])
  // — both writes commit together so a failed summary never leaves the
  // flag falsely cleared (and vice versa).
  assert.match(
    resummarizeFnBody(),
    /\$transaction\(\s*\[\s*summaryWrite\s*,[\s\S]*?messageAudioTranscription\.updateMany\([\s\S]*?needsAiRefresh:\s*false[\s\S]*?\}\s*\)\s*\]\s*\)/,
    "expected the needsAiRefresh clear to run inside the summary-write $transaction"
  );
});

test("resummarizeThreadById never SETS needsAiRefresh true (clear-only; AI spend stays gated behind Reassess)", () => {
  assert.doesNotMatch(
    resummarizeFnBody(),
    /needsAiRefresh:\s*true/,
    "resummarizeThreadById must only clear needsAiRefresh, never set it"
  );
});
