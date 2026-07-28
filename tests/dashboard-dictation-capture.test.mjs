import assert from "node:assert/strict";
import test from "node:test";

const {
  dictationCaptureAvailability,
  dictationCaptureRecoveryMessage,
  startDictationCapture
} = await import("../apps/dashboard/lib/dictation-capture.ts");

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
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

test("secure capture requests only the current browser device microphone", async () => {
  const stream = makeStream();
  let constraints;
  const session = await startDictationCapture({
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
  const session = await startDictationCapture({
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(error) {
      throw error;
    },
    onRecorded(blob) {
      recorded = blob;
    }
  });

  session.stop();
  assert.equal(recorded.type, "audio/webm;codecs=opus");
  assert.ok(recorded.size > 0);
  assert.ok(stream.tracks.every((track) => track.stopped));
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
      MediaRecorderClass: BrokenMediaRecorder,
      mediaDevices: { getUserMedia: async () => stream },
      onError() {},
      onRecorded() {}
    }),
    /could not start/
  );
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("revoked microphone permission stops capture and reports recovery", async () => {
  const stream = makeStream();
  let error;
  await startDictationCapture({
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: { getUserMedia: async () => stream },
    onError(next) {
      error = next;
    },
    onRecorded() {}
  });

  stream.tracks[0].endUnexpectedly();
  assert.equal(error.name, "NotAllowedError");
  assert.ok(stream.tracks.every((track) => track.stopped));
});

test("capture rejects and releases any stream containing a camera track", async () => {
  const stream = makeStream({ audio: 1, video: 1 });
  await assert.rejects(
    startDictationCapture({
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
});
