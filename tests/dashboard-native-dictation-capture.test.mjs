import assert from "node:assert/strict";
import test from "node:test";

const {
  nativeDictationCaptureAvailable,
  startNativeDictationCapture
} = await import("../apps/dashboard/lib/native-dictation-capture.ts");

class NativeWindow extends EventTarget {
  constructor(messages) {
    super();
    this.webkit = {
      messageHandlers: {
        toviDictation: {
          postMessage: (message) => messages.push(message)
        }
      }
    };
  }
}

function nativeEvent(detail) {
  return new CustomEvent("tovi-native-dictation", { detail });
}

test("native bridge starts, remains active across lifecycle interrupts, and returns audio", async () => {
  const messages = [];
  const targetWindow = new NativeWindow(messages);
  let recorded;
  const sessionPromise = startNativeDictationCapture({
    targetWindow,
    onError(error) {
      throw error;
    },
    onRecorded(blob) {
      recorded = blob;
    }
  });
  const sessionId = messages[0].sessionId;
  targetWindow.dispatchEvent(nativeEvent({ type: "started", sessionId }));
  const session = await sessionPromise;

  assert.equal(nativeDictationCaptureAvailable(targetWindow), true);
  assert.equal(session.native, true);
  session.interrupt("backgrounded");
  assert.equal(messages.length, 1);
  session.resume();
  assert.deepEqual(messages[1], { command: "status", sessionId });
  session.stop();
  assert.deepEqual(messages[2], { command: "stop", sessionId });

  targetWindow.dispatchEvent(nativeEvent({
    type: "recorded",
    sessionId,
    dataUrl: "data:audio/mp4;base64,bmF0aXZlLWF1ZGlv",
    mimeType: "audio/mp4"
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await recorded.text(), "native-audio");
  assert.deepEqual(messages[3], { command: "acknowledge", sessionId });
});

test("native audio interruption returns the saved partial clip", async () => {
  const messages = [];
  const targetWindow = new NativeWindow(messages);
  let recovery;
  const sessionPromise = startNativeDictationCapture({
    targetWindow,
    onError(error) {
      throw error;
    },
    onInterrupted(next) {
      recovery = next;
    },
    onRecorded() {}
  });
  const sessionId = messages[0].sessionId;
  targetWindow.dispatchEvent(nativeEvent({ type: "started", sessionId }));
  await sessionPromise;
  targetWindow.dispatchEvent(nativeEvent({
    type: "recorded",
    sessionId,
    dataUrl: "data:audio/mp4;base64,cGFydGlhbA==",
    mimeType: "audio/mp4",
    interruptionReason: "audio-interruption",
    startedAt: 10,
    endedAt: 20
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(recovery.interruptionReason, "audio-interruption");
  assert.equal(await recovery.blob.text(), "partial");
  assert.deepEqual(messages[1], { command: "acknowledge", sessionId });
});
