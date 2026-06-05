import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunnerConfig } from "../apps/runner/dist/config.js";

// Audit on the provider-defaulting layer of `resolveRunnerConfig`. The
// product rule: no path silently spends OpenAI tokens. OpenAI runs ONLY
// when `AUDIO_TRANSCRIPTION_PROVIDER=openai` is the explicit env value.
// Any other input (unset, blank, mis-spelled, capitalised) collapses to
// `local-whisper`, the cost-safe default.

function envWithProvider(provider) {
  // Build a minimal env that still satisfies the other config defaults.
  // Only the audio-transcription fields matter here; everything else
  // falls through to `resolveRunnerConfig`'s built-in defaults.
  return {
    ...(provider === undefined ? {} : { AUDIO_TRANSCRIPTION_PROVIDER: provider }),
    AUDIO_TRANSCRIPTION_ENABLED: "true",
    OPENAI_API_KEY: "sk-test-only"
  };
}

test("unset AUDIO_TRANSCRIPTION_PROVIDER defaults to local-whisper", () => {
  const cfg = resolveRunnerConfig(envWithProvider(undefined));
  assert.equal(cfg.audioTranscription.provider, "local-whisper");
});

test("blank string defaults to local-whisper", () => {
  const cfg = resolveRunnerConfig(envWithProvider(""));
  assert.equal(cfg.audioTranscription.provider, "local-whisper");
});

test("whitespace-only string defaults to local-whisper", () => {
  const cfg = resolveRunnerConfig(envWithProvider("   "));
  assert.equal(cfg.audioTranscription.provider, "local-whisper");
});

test("a mis-spelled provider name defaults to local-whisper, not openai", () => {
  // 'openi' shouldn't route the runner into the paid path. We
  // deliberately fall through to local-whisper rather than throwing.
  const cfg = resolveRunnerConfig(envWithProvider("openi"));
  assert.equal(cfg.audioTranscription.provider, "local-whisper");
});

test("explicit AUDIO_TRANSCRIPTION_PROVIDER=openai is the only path to openai", () => {
  const cfg = resolveRunnerConfig(envWithProvider("openai"));
  assert.equal(cfg.audioTranscription.provider, "openai");
});

test("explicit AUDIO_TRANSCRIPTION_PROVIDER=OpenAI (mixed case) resolves to openai", () => {
  // Case-insensitive on the canonical name. Anything that isn't a
  // case-insensitive match for `openai` lands on local-whisper.
  const cfg = resolveRunnerConfig(envWithProvider("OpenAI"));
  assert.equal(cfg.audioTranscription.provider, "openai");
});

test("explicit AUDIO_TRANSCRIPTION_PROVIDER=local-whisper resolves to local-whisper", () => {
  const cfg = resolveRunnerConfig(envWithProvider("local-whisper"));
  assert.equal(cfg.audioTranscription.provider, "local-whisper");
});
