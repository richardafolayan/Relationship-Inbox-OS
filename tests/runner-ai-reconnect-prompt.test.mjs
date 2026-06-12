import test from "node:test";
import assert from "node:assert/strict";
import {
  RECONNECT_SCORE_PROMPT,
  reconnectPlatformContext
} from "../apps/runner/dist/services/ai.js";

// Structural verification of the reconnect-score prompt. Behaviour
// (does the AI score sensibly?) is tested against the operator's
// running setup with real provider keys, not in CI.

test("RECONNECT_SCORE_PROMPT defines the 0-100 scoring band", () => {
  assert.match(RECONNECT_SCORE_PROMPT, /Rate, from 0 to 100/);
  // Conservative middle: a score of 50 must read as "neutral"
  assert.match(RECONNECT_SCORE_PROMPT, /50-69/);
});

test("RECONNECT_SCORE_PROMPT lays out all five score bands", () => {
  assert.match(RECONNECT_SCORE_PROMPT, /90-100/);
  assert.match(RECONNECT_SCORE_PROMPT, /70-89/);
  assert.match(RECONNECT_SCORE_PROMPT, /50-69/);
  assert.match(RECONNECT_SCORE_PROMPT, /20-49/);
  assert.match(RECONNECT_SCORE_PROMPT, /0-19/);
});

test("RECONNECT_SCORE_PROMPT instructs the model to be conservative", () => {
  // Conservative wording matters: a falsely-high score nudges the
  // operator into awkward outreach.
  assert.match(RECONNECT_SCORE_PROMPT, /conservative/i);
  assert.match(RECONNECT_SCORE_PROMPT, /lean toward the middle/i);
});

test("RECONNECT_SCORE_PROMPT pins the JSON output contract", () => {
  assert.match(
    RECONNECT_SCORE_PROMPT,
    /Return strict JSON: \{ "score": 0-100 integer, "reason": "[^"]+" \}/
  );
});

test("RECONNECT_SCORE_PROMPT caps the reason at one short sentence", () => {
  assert.match(RECONNECT_SCORE_PROMPT, /one short sentence/i);
  assert.match(RECONNECT_SCORE_PROMPT, /no more than 25 words/i);
});

test("RECONNECT_SCORE_PROMPT explicitly forbids invented details", () => {
  // The relationship-signal scoring already covers depth + recency
  // deterministically; the model must not embellish on top.
  assert.match(RECONNECT_SCORE_PROMPT, /Do not invent details/i);
});

// Reconnect covers every platform now (it began LinkedIn-only). The base
// rubric must stay platform-neutral; per-platform framing is appended via
// reconnectPlatformContext.

test("base prompt is platform-neutral", () => {
  assert.doesNotMatch(RECONNECT_SCORE_PROMPT, /LinkedIn/i);
  assert.doesNotMatch(RECONNECT_SCORE_PROMPT, /iMessage/i);
});

test("every platform has a context fragment that names it", () => {
  assert.match(reconnectPlatformContext("LINKEDIN"), /LinkedIn/);
  assert.match(reconnectPlatformContext("IMESSAGE"), /iMessage/);
  assert.match(reconnectPlatformContext("INSTAGRAM"), /Instagram/);
  assert.match(reconnectPlatformContext("TIKTOK"), /TikTok/);
});

test("LinkedIn framing stays professional", () => {
  const fragment = reconnectPlatformContext("LINKEDIN");
  assert.match(fragment, /professional/i);
  assert.match(fragment, /role or company change/i);
});

test("iMessage framing protects natural friend lulls from guilt scoring", () => {
  // The original reason Reconnect excluded iMessage: a "you should
  // message your sister" nudge about a normal lull feels wrong. That
  // caution now lives in the scorer prompt instead of a platform gate.
  const fragment = reconnectPlatformContext("IMESSAGE");
  assert.match(fragment, /lulls .* are completely normal/i);
  assert.match(fragment, /never score as if the operator has neglected/i);
  // Logistical texting (deliveries, codes) must not look like a tie.
  assert.match(fragment, /verification codes/i);
});

test("Instagram and TikTok framing demands real mutual exchange", () => {
  for (const platform of ["INSTAGRAM", "TIKTOK"]) {
    const fragment = reconnectPlatformContext(platform);
    assert.match(fragment, /casual social tie/i);
    assert.match(fragment, /mutual back-and-forth/i);
  }
});
