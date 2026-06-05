import test from "node:test";
import assert from "node:assert/strict";
import {
  getVoiceTier,
  selectVoicePrompt,
  operatorProfileFragment,
  operatorProfileFingerprint,
  SYSTEM_PROMPT
} from "../apps/runner/dist/services/ai.js";

test("getVoiceTier maps LINKEDIN to formal", () => {
  assert.equal(getVoiceTier("LINKEDIN"), "formal");
});

test("getVoiceTier maps INSTAGRAM to casual", () => {
  assert.equal(getVoiceTier("INSTAGRAM"), "casual");
});

test("getVoiceTier maps TIKTOK to casual", () => {
  assert.equal(getVoiceTier("TIKTOK"), "casual");
});

test("getVoiceTier maps WHATSAPP to casual", () => {
  assert.equal(getVoiceTier("WHATSAPP"), "casual");
});

test("formal voice prompt is a generic scaffold, not a hardcoded persona", () => {
  const prompt = selectVoicePrompt("LINKEDIN");
  // The product must work for someone who is not the original author.
  assert.doesNotMatch(prompt, /Richard/);
  assert.doesNotMatch(prompt, /Creality/);
  assert.doesNotMatch(prompt, /on behalf of/i);
  // It still describes professional-register writing and the profile seam.
  assert.match(prompt, /professional/i);
  assert.match(prompt, /WRITE AS THIS PERSON/);
  assert.match(prompt, /plain, natural/i);
});

test("casual voice prompt is a generic scaffold, not a hardcoded persona", () => {
  const prompt = selectVoicePrompt("INSTAGRAM");
  assert.doesNotMatch(prompt, /Richard/);
  assert.doesNotMatch(prompt, /MLE young-adult/);
  // The author's specific emoji palette must not be baked into the prompt.
  assert.doesNotMatch(prompt, /🌚/);
  assert.doesNotMatch(prompt, /🥀/);
  assert.match(prompt, /casual/i);
  assert.match(prompt, /WRITE AS THIS PERSON/);
  assert.match(prompt, /plain, natural/i);
});

test("the system prompt does not hardcode the author's identity", () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /Richard/);
});

test("formal and casual prompts are distinct", () => {
  assert.notEqual(selectVoicePrompt("LINKEDIN"), selectVoicePrompt("INSTAGRAM"));
});

test("operatorProfileFragment is empty when no profile is configured", () => {
  assert.equal(operatorProfileFragment(null), "");
  assert.equal(operatorProfileFragment(undefined), "");
  assert.equal(
    operatorProfileFragment({
      displayName: "",
      about: "",
      interests: "",
      commonPhrases: "",
      avoidedPhrases: "",
      preferredStyle: "",
      aiHelpLevel: "writing_support",
      setupCompletedAt: ""
    }),
    ""
  );
});

test("operatorProfileFragment injects the configured user, not a hardcoded persona", () => {
  const fragment = operatorProfileFragment({
    displayName: "Priya",
    about: "Short and warm, I get to the point",
    interests: "product design, pottery",
    commonPhrases: "no worries, sounds good",
    avoidedPhrases: "circle back, touch base",
    preferredStyle: "concise",
    aiHelpLevel: "full_drafts",
    setupCompletedAt: "2026-05-21T00:00:00.000Z"
  });
  assert.match(fragment, /WRITE AS THIS PERSON/);
  assert.match(fragment, /Priya/);
  assert.match(fragment, /Short and warm/);
  assert.match(fragment, /no worries, sounds good/);
  assert.match(fragment, /circle back, touch base/);
  assert.match(fragment, /concise/);
  assert.doesNotMatch(fragment, /Richard/);
});

test("operatorProfileFingerprint changes when voice fields change", () => {
  const base = {
    displayName: "Sam",
    about: "casual",
    interests: "",
    commonPhrases: "",
    avoidedPhrases: "",
    preferredStyle: "",
    aiHelpLevel: "writing_support",
    setupCompletedAt: ""
  };
  const renamed = { ...base, displayName: "Alex" };
  const restyled = { ...base, preferredStyle: "direct" };
  assert.notEqual(operatorProfileFingerprint(base), operatorProfileFingerprint(renamed));
  assert.notEqual(operatorProfileFingerprint(base), operatorProfileFingerprint(restyled));
  // aiHelpLevel only affects what the dashboard surfaces, not the text the
  // model produces, so it must not churn the suggested-replies cache.
  assert.equal(
    operatorProfileFingerprint(base),
    operatorProfileFingerprint({ ...base, aiHelpLevel: "full_drafts" })
  );
});
