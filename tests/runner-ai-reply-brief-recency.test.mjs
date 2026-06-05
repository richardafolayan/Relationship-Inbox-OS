import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRIEF_RECENCY_DISCIPLINE,
  SECOND_PERSON_RESOLUTION,
  LIVE_EXCHANGE_MARKER,
  LIVE_EXCHANGE_WINDOW_MS,
  liveExchangeStartIndex,
  buildReassessTranscript
} from "../apps/runner/dist/services/ai.js";

// Bug: "Why is it referencing things that occurred ages ago, the internship
// finished nearly a year ago?" The reassess prompt feeds up to the most
// recent 120 messages — which on a long thread reaches back ~10 months — and
// the reply-brief sections had no recency horizon, so a one-off beat from
// Aug 2025 ("I'm doing an internship") surfaced in they_said / on_you as
// live reply debt. A second bug in the same brief: the contact's
// "congratulations on finishing uni" (addressed to the operator) was flipped
// into "Annalise finished university, congratulate her".
//
// Fix: (1) BRIEF_RECENCY_DISCIPLINE + a code-computed LIVE_EXCHANGE_MARKER
// boundary so the brief is anchored to the live exchange, and
// (2) SECOND_PERSON_RESOLUTION so "you did X" from the contact is read as
// the operator's milestone. These tests pin the language and prove the
// boundary logic on an Annalise-shaped transcript. They do NOT run an LLM —
// behavioural verification is a live Reassess of the thread.

// An Annalise-shaped transcript: a one-off internship beat ~10 months before
// the live exchange, then the recent uni/exam run.
const ANNALISE_MESSAGES = [
  { direction: "IN", text: "I'm doing an internship actually", timestamp: "2025-08-09T00:10:37.000Z" },
  { direction: "OUT", text: "Brooo I jumped at the opportunity", timestamp: "2026-02-21T10:41:32.000Z" },
  { direction: "OUT", text: "generally though how you feeling, n w exams coming up", timestamp: "2026-05-05T18:13:16.000Z" },
  { direction: "IN", text: "I've never felt so bad for exams but we trust in God", timestamp: "2026-05-17T13:30:24.000Z" },
  { direction: "IN", text: "You're nearly done with uni", timestamp: "2026-05-17T13:30:39.000Z" },
  { direction: "IN", text: "Congratulations on finishing uni", timestamp: "2026-05-22T18:06:39.000Z" }
];

// ── BRIEF_RECENCY_DISCIPLINE language ──────────────────────────────────
test("BRIEF_RECENCY_DISCIPLINE is exported and teaches the live-exchange recency horizon", () => {
  assert.equal(typeof BRIEF_RECENCY_DISCIPLINE, "string");
  assert.ok(BRIEF_RECENCY_DISCIPLINE.length > 0);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /RECENCY/);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /LIVE EXCHANGE BELOW/);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /OLDER BACKGROUND/);
  // The four live brief fields must be named as the recency-scoped ones.
  assert.match(BRIEF_RECENCY_DISCIPLINE, /they_said/);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /where_it_stands/);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /on_you/);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /required_points/);
  // Must call the old beat stale and route durable facts elsewhere.
  assert.match(BRIEF_RECENCY_DISCIPLINE, /stale/i);
  assert.match(BRIEF_RECENCY_DISCIPLINE, /remember or durable_context/);
  // Must keep the "this week" framing of a long-past event out.
  assert.match(BRIEF_RECENCY_DISCIPLINE, /this week/);
  // No copyable persona / example names leaked into the prompt text.
  assert.doesNotMatch(BRIEF_RECENCY_DISCIPLINE, /Annalise|Richard/);
});

// ── SECOND_PERSON_RESOLUTION language ──────────────────────────────────
test("SECOND_PERSON_RESOLUTION is exported and resolves \"you\" against the speaker", () => {
  assert.equal(typeof SECOND_PERSON_RESOLUTION, "string");
  assert.ok(SECOND_PERSON_RESOLUTION.length > 0);
  assert.match(SECOND_PERSON_RESOLUTION, /SECOND-PERSON RESOLUTION/);
  // In a contact line "you" means the operator.
  assert.match(SECOND_PERSON_RESOLUTION, /"you"[\s\S]*OPERATOR|OPERATOR[\s\S]*"you"/);
  // The exact failure mode: "you finished uni" / congrats is the operator's.
  assert.match(SECOND_PERSON_RESOLUTION, /you finished uni/);
  assert.match(SECOND_PERSON_RESOLUTION, /congratulate the contact/);
  // The obligation is to receive the congratulations, not mirror it back.
  assert.match(SECOND_PERSON_RESOLUTION, /thank them|receive it/i);
  assert.doesNotMatch(SECOND_PERSON_RESOLUTION, /Annalise|Richard/);
});

// ── live-exchange boundary computation ─────────────────────────────────
test("liveExchangeStartIndex: separates the 10-month-old internship from the live uni exchange", () => {
  // Most recent inbound = 2026-05-22; cutoff = that minus 21 days = 2026-05-01.
  // index 0 (Aug 2025) and index 1 (Feb 2026) are older background; index 2
  // (May 5) is the first message inside the live window.
  assert.equal(liveExchangeStartIndex(ANNALISE_MESSAGES), 2);
});

test("liveExchangeStartIndex: returns -1 when the whole transcript is already recent (no boundary)", () => {
  const allRecent = [
    { direction: "OUT", text: "yo", timestamp: "2026-05-20T10:00:00.000Z" },
    { direction: "IN", text: "hey", timestamp: "2026-05-21T10:00:00.000Z" },
    { direction: "IN", text: "you free?", timestamp: "2026-05-22T10:00:00.000Z" }
  ];
  assert.equal(liveExchangeStartIndex(allRecent), -1);
});

test("liveExchangeStartIndex: returns -1 when there is no inbound to anchor on", () => {
  const noInbound = [
    { direction: "OUT", text: "you up?", timestamp: "2025-08-09T00:10:00.000Z" },
    { direction: "OUT", text: "ping", timestamp: "2026-05-22T18:06:00.000Z" }
  ];
  assert.equal(liveExchangeStartIndex(noInbound), -1);
});

test("liveExchangeStartIndex: returns -1 for an empty transcript", () => {
  assert.equal(liveExchangeStartIndex([]), -1);
});

test("liveExchangeStartIndex: boundary is relative to the most recent inbound, not 'now' (dormant thread)", () => {
  // The most recent inbound is itself old; the live exchange is the run
  // clustered around it, and earlier history is still background.
  const dormant = [
    { direction: "IN", text: "old beat", timestamp: "2025-01-01T10:00:00.000Z" },
    { direction: "OUT", text: "reply", timestamp: "2025-01-02T10:00:00.000Z" },
    { direction: "IN", text: "last thing she said", timestamp: "2025-09-10T10:00:00.000Z" }
  ];
  // cutoff = 2025-09-10 minus 21 days = 2025-08-20; only index 2 qualifies.
  assert.equal(liveExchangeStartIndex(dormant), 2);
});

test("LIVE_EXCHANGE_WINDOW_MS is 21 days", () => {
  assert.equal(LIVE_EXCHANGE_WINDOW_MS, 21 * 24 * 60 * 60 * 1000);
});

// ── transcript rendering with the marker ───────────────────────────────
test("buildReassessTranscript: inserts the marker once, with the internship ABOVE and the live uni run BELOW", () => {
  const transcript = buildReassessTranscript(ANNALISE_MESSAGES, "Annalise");
  // Marker appears exactly once.
  assert.equal(transcript.split(LIVE_EXCHANGE_MARKER).length, 2);
  const markerAt = transcript.indexOf(LIVE_EXCHANGE_MARKER);
  const internshipAt = transcript.indexOf("internship");
  const congratsAt = transcript.indexOf("Congratulations on finishing uni");
  assert.ok(internshipAt >= 0 && congratsAt >= 0 && markerAt >= 0);
  // The 10-month-old internship is in the OLDER BACKGROUND (above the marker).
  assert.ok(internshipAt < markerAt, "internship should be above the live-exchange marker");
  // The live uni congratulations is BELOW the marker.
  assert.ok(congratsAt > markerAt, "the live congratulations should be below the marker");
  // Speaker labels still bind the contact name to their turns.
  assert.match(transcript, /Annalise \(2026-05-22/);
});

test("buildReassessTranscript: no marker for a short all-recent thread (renders as before)", () => {
  const allRecent = [
    { direction: "OUT", text: "yo", timestamp: "2026-05-20T10:00:00.000Z" },
    { direction: "IN", text: "hey", timestamp: "2026-05-22T10:00:00.000Z" }
  ];
  const transcript = buildReassessTranscript(allRecent, "Sam");
  assert.equal(transcript.includes(LIVE_EXCHANGE_MARKER), false);
  // Still a normal transcript.
  assert.match(transcript, /operator \(2026-05-20/);
  assert.match(transcript, /Sam \(2026-05-22/);
});

// ── wiring into the assembled reassess prompt ──────────────────────────
test("the recency + attribution fragments are wired into the reassess prompt, and the transcript uses the marker builder", () => {
  const aiJsPath = fileURLToPath(
    new URL("../apps/runner/dist/services/ai.js", import.meta.url)
  );
  const source = readFileSync(aiJsPath, "utf8");
  // Both fragments must be template-injected into a prompt (the ${...} form,
  // so prose mentions in comments don't count).
  assert.ok(
    source.includes("${BRIEF_RECENCY_DISCIPLINE}"),
    "BRIEF_RECENCY_DISCIPLINE must be injected into the reassess prompt"
  );
  assert.ok(
    source.includes("${SECOND_PERSON_RESOLUTION}"),
    "SECOND_PERSON_RESOLUTION must be injected into the reassess prompt"
  );
  // The transcript fed to the brief must go through the marker-aware builder,
  // not the bare map(formatMessageForPrompt).join — that is the mechanism
  // that gives the model the recency cutoff.
  assert.ok(
    source.includes("buildReassessTranscript(input.messages"),
    "the reassess transcript must be built via buildReassessTranscript"
  );
});
