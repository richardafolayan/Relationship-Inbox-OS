import assert from "node:assert/strict";
import test from "node:test";

const {
  dictationCaptureAvailability,
  dictationCaptureRecoveryMessage,
  startDictationCapture
} = await import("../apps/dashboard/lib/dictation-capture.ts");
const {
  createMemoryDictationChunkStore,
  dictationInterruptionMessage
} = await import("../apps/dashboard/lib/dictation-chunk-store.ts");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeTrack(kind) {
  const listeners = new Map();
  return {
    kind,
    stopped: false,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    endUnexpectedly() {
      listeners.get("ended")?.();
    },
    stop() {
      this.stopped = true;
    }
  };
}

function makeStream({ audio = 1, video = 0 } = {}) {
  const tracks = [
    ...Array.from({ length: audio }, () => makeTrack("audio")),
    ...Array.from({ length: video }, () => makeTrack("video"))
  ];
  return {
    tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === "video")
  };
}

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }

  constructor(stream, options) {
    this.mimeType = options?.mimeType || "audio/webm";
    this.state = "inactive";
    this.stream = stream;
  }

  start() {
    this.state = "recording";
    this.timeslice = arguments[0];
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded"], { type: this.mimeType }) });
    this.onstop?.();
  }

  requestData() {
    this.ondataavailable?.({ data: new Blob(["partial"], { type: this.mimeType }) });
  }
}

test("secure capture requests only the current browser device microphone", async () => {
  const stream = makeStream();
  let constraints;
  const session = await startDictationCapture({
    chunkStore: createMemoryDictationChunkStore(),
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: {
      async getUserMedia(next) {
        constraints = next;
        return stream;
      }
    },
    onError(error) {
      throw error;
    },
    onRecorded() {}
  });

  assert.equal(constraints.video, false);
  assert.equal(constraints.audio.echoCancellation, true);
  assert.equal(session.stream, stream);
  session.cancel();
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("capture stops microphone tracks after Stop and produces WebM audio", async () => {
  const stream = makeStream();
  let recorded;
  let released = false;
  const session = await startDictationCapture({
    chunkStore: createMemoryDictationChunkStore(),
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(error) {
      throw error;
    },
    onRecorded(blob) {
      recorded = blob;
    },
    wakeLock: {
      async request() {
        return {
          async release() {
            released = true;
          }
        };
      }
    }
  });

  assert.equal(session.recorder.timeslice, 1_000);
  session.stop();
  await nextTurn();
  assert.equal(recorded.type, "audio/webm;codecs=opus");
  assert.ok(recorded.size > 0);
  assert.ok(stream.tracks.every((track) => track.stopped));
  assert.equal(released, true);
});

test("Safari MP4 capture keeps a complete audio-only MP4 blob", async () => {
  class SafariMediaRecorder extends FakeMediaRecorder {
    static isTypeSupported(type) {
      return type === "audio/mp4;codecs=mp4a.40.2";
    }
  }
  const stream = makeStream();
  let recorded;
  const session = await startDictationCapture({
    chunkStore: createMemoryDictationChunkStore(),
    MediaRecorderClass: SafariMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(error) {
      throw error;
    },
    onRecorded(blob) {
      recorded = blob;
    }
  });

  session.stop();
  await nextTurn();
  assert.equal(recorded.type, "audio/mp4;codecs=mp4a.40.2");
  assert.ok(recorded.size > 0);
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("capture stops microphone tracks after recorder setup failure", async () => {
  const stream = makeStream();
  class BrokenMediaRecorder extends FakeMediaRecorder {
    start() {
      throw new DOMException("could not start", "NotReadableError");
    }
  }

  await assert.rejects(
    startDictationCapture({
      chunkStore: createMemoryDictationChunkStore(),
      MediaRecorderClass: BrokenMediaRecorder,
      mediaDevices: { getUserMedia: async () => stream },
      onError() {},
      onRecorded() {}
    }),
    /could not start/
  );
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("revoked microphone permission stops capture and preserves completed chunks", async () => {
  const stream = makeStream();
  let recovery;
  await startDictationCapture({
    chunkStore: createMemoryDictationChunkStore(),
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(error) {
      throw error;
    },
    onInterrupted(next) {
      recovery = next;
    },
    onRecorded() {}
  });

  stream.tracks[0].endUnexpectedly();
  await nextTurn();
  assert.equal(recovery.interruptionReason, "track-ended");
  assert.ok(recovery.blob.size > 0);
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("capture rejects and releases any stream containing a camera track", async () => {
  const stream = makeStream({ audio: 1, video: 1 });
  await assert.rejects(
    startDictationCapture({
      chunkStore: createMemoryDictationChunkStore(),
      MediaRecorderClass: FakeMediaRecorder,
      mediaDevices: { getUserMedia: async () => stream },
      onError() {},
      onRecorded() {}
    }),
    /invalid capture stream/
  );
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("capability copy distinguishes insecure and unsupported browsers", () => {
  assert.deepEqual(
    dictationCaptureAvailability({
      isSecureContext: false,
      mediaDevices: { getUserMedia() {} },
      MediaRecorderClass: FakeMediaRecorder
    }),
    { available: false, reason: "insecure" }
  );
  assert.match(dictationCaptureRecoveryMessage("insecure"), /HTTPS QR code/);
  assert.deepEqual(
    dictationCaptureAvailability({ isSecureContext: true }),
    { available: false, reason: "unsupported" }
  );
  assert.deepEqual(
    dictationCaptureAvailability({
      isSecureContext: false,
      nativeAvailable: true
    }),
    { available: true, reason: null }
  );
});

test("background interruption keeps chunk order and reports the missing interval", async () => {
  class ChunkedMediaRecorder extends FakeMediaRecorder {
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["last"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const stream = makeStream();
  let recovery;
  let recorded = false;
  const session = await startDictationCapture({
    chunkStore: createMemoryDictationChunkStore(),
    MediaRecorderClass: ChunkedMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(error) {
      throw error;
    },
    onInterrupted(next) {
      recovery = next;
    },
    onRecorded() {
      recorded = true;
    }
  });

  session.recorder.ondataavailable({
    data: new Blob(["first"], { type: session.recorder.mimeType })
  });
  session.interrupt("backgrounded");
  await nextTurn();

  assert.equal(recorded, false);
  assert.equal(recovery.interruptionReason, "backgrounded");
  assert.equal(await recovery.blob.text(), "firstpartiallast");
  assert.match(dictationInterruptionMessage("backgrounded"), /may be missing/);
});
