import test from "node:test";
import assert from "node:assert/strict";
import { getVoiceTier, selectVoicePrompt } from "../apps/runner/dist/services/ai.js";

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

test("selectVoicePrompt for LINKEDIN returns the formal prompt", () => {
  const prompt = selectVoicePrompt("LINKEDIN");
  assert.match(prompt, /You are writing LinkedIn messages as Richard/);
  assert.match(prompt, /Hey long time man, yhh things are going pretty good to be fair/);
});

test("selectVoicePrompt for casual platforms returns the casual prompt", () => {
  const prompt = selectVoicePrompt("INSTAGRAM");
  assert.match(prompt, /MLE young-adult register/);
  assert.match(prompt, /moretime/);
  assert.match(prompt, /🌚/);
});

test("formal and casual prompts are distinct", () => {
  assert.notEqual(selectVoicePrompt("LINKEDIN"), selectVoicePrompt("INSTAGRAM"));
});
