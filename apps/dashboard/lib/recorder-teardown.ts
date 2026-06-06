// #PM1: shared teardown for the thread composer's voice-note and dictation
// MediaRecorders. The recorders normally stop their mic tracks inside their
// own `onstop` handler, but that fires only on an explicit `.stop()`. When
// the thread view unmounts mid-record (navigating away) no stop callback
// runs, so the mic stream is left live and the recorder/stream leak. The
// unmount cleanup calls this helper to stop the recorder and release every
// track directly, regardless of whether `onstop` ever runs.
//
// Extracted as a pure function so the teardown decision is unit-testable
// without a DOM (the page itself is React-UI-only). It is null-safe on both
// arguments and never throws: `MediaRecorder.stop()` raises InvalidStateError
// when the recorder is already inactive, and a track may already be ended.
export function stopRecorderAndStream(
  recorder: MediaRecorder | null | undefined,
  stream: MediaStream | null | undefined
): void {
  if (recorder) {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* already inactive or detached — nothing to stop */
    }
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* track already ended */
      }
    }
  }
}
