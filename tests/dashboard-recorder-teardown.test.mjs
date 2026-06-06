import test from "node:test";
import assert from "node:assert/strict";

// #PM1. The dashboard ships ESM TypeScript; this test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import
// below — see test:all in the root package.json.
const { stopRecorderAndStream } = await import(
  "../apps/dashboard/lib/recorder-teardown.ts"
);

function makeTrack() {
  return {
    stopped: false,
    stop() {
      this.stopped = true;
    }
  };
}

function makeStream(trackCount) {
  const tracks = Array.from({ length: trackCount }, makeTrack);
  return {
    tracks,
    getTracks() {
      return this.tracks;
    }
  };
}

function makeRecorder(state) {
  return {
    state,
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      this.state = "inactive";
    }
  };
}

test("stops an active recorder and every mic track", () => {
  const recorder = makeRecorder("recording");
  const stream = makeStream(2);

  stopRecorderAndStream(recorder, stream);

  assert.equal(recorder.stopCalls, 1, "recording recorder should be stopped once");
  assert.ok(
    stream.tracks.every((t) => t.stopped),
    "every track on the stream should be stopped (mic released)"
  );
});

test("does not re-stop an already-inactive recorder but still stops tracks", () => {
  const recorder = makeRecorder("inactive");
  const stream = makeStream(1);

  stopRecorderAndStream(recorder, stream);

  assert.equal(recorder.stopCalls, 0, "inactive recorder must not be stopped again");
  assert.ok(stream.tracks[0].stopped, "track should still be stopped");
});

test("stops a paused recorder", () => {
  const recorder = makeRecorder("paused");
  const stream = makeStream(1);

  stopRecorderAndStream(recorder, stream);

  assert.equal(recorder.stopCalls, 1, "paused recorder should be stopped");
  assert.ok(stream.tracks[0].stopped);
});

test("is null-safe on both arguments", () => {
  assert.doesNotThrow(() => stopRecorderAndStream(null, null));
  assert.doesNotThrow(() => stopRecorderAndStream(undefined, undefined));

  // recorder present, stream missing
  const recorder = makeRecorder("recording");
  assert.doesNotThrow(() => stopRecorderAndStream(recorder, null));
  assert.equal(recorder.stopCalls, 1);

  // stream present, recorder missing
  const stream = makeStream(2);
  assert.doesNotThrow(() => stopRecorderAndStream(null, stream));
  assert.ok(stream.tracks.every((t) => t.stopped));
});

test("swallows a throwing recorder.stop and still stops tracks", () => {
  const recorder = {
    state: "recording",
    stop() {
      throw new DOMException("InvalidStateError");
    }
  };
  const stream = makeStream(1);

  assert.doesNotThrow(() => stopRecorderAndStream(recorder, stream));
  assert.ok(stream.tracks[0].stopped, "tracks must still stop even if recorder.stop throws");
});
