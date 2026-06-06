import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Q11: VoiceMessageTranscript seeded its `local` transcription state from the
// `transcription` prop with useState(transcription ?? null) and never
// reconciled later prop changes. The thread page re-fetches /data/thread on
// every SSE event, every send, and a 3s poll tick, so `message.audioTranscription`
// updates over time as the runner finishes background work — a higher-tier
// (refinement) transcript lands, a previously-pending row flips to
// "transcribed", or `isImproving` toggles. None of those reached the component:
// it stayed frozen at the mount-time value.
//
// The component is not unit-mountable here (the repo has react-dom but no
// react-test-renderer / @testing-library), so this is a static-source
// regression in the same idiom as dashboard-thread-page-state-race-guards and
// dashboard-today-name-suggestion-refresh: the assertions fail if the
// reconciling effect (or its useEffect import) is removed.

const SRC = readFileSync(
  fileURLToPath(
    new URL("../apps/dashboard/components/thread/imessage-media.tsx", import.meta.url)
  ),
  "utf8"
);

test("imports useEffect from react", () => {
  // The reconcile effect needs useEffect in scope.
  assert.match(
    SRC,
    /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/,
    "imessage-media.tsx must import useEffect"
  );
});

test("VoiceMessageTranscript reconciles the transcription prop into local state", () => {
  // Scope the assertion to the VoiceMessageTranscript body so it can't be
  // satisfied by an unrelated effect elsewhere in the file.
  const start = SRC.indexOf("export function VoiceMessageTranscript");
  assert.ok(start !== -1, "VoiceMessageTranscript export should exist");
  const end = SRC.indexOf("export function IMessageMedia");
  assert.ok(end !== -1 && end > start, "IMessageMedia export should follow it");
  const body = SRC.slice(start, end);

  // Still seeds optimistically from the prop at mount (kept for the on-demand
  // trigger's optimism) ...
  assert.match(
    body,
    /useState<[^>]*>\(\s*transcription\s*\?\?\s*null\s*\)/,
    "local state should still be seeded from the transcription prop"
  );

  // ... AND a useEffect must push later prop values back into local state, keyed
  // on `transcription`, so background-completed transcripts and refinement
  // upgrades reconcile instead of being frozen at mount.
  const effect = body.match(
    /useEffect\(\s*\(\)\s*=>\s*\{\s*setLocal\(\s*transcription\s*\?\?\s*null\s*\)\s*;?\s*\}\s*,\s*\[\s*transcription\s*\]\s*\)/
  );
  assert.ok(
    effect,
    "VoiceMessageTranscript must reconcile the transcription prop via " +
      "useEffect(() => { setLocal(transcription ?? null); }, [transcription])"
  );
});
