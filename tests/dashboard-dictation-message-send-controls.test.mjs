import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewSource = await readFile(
  new URL("../apps/dashboard/components/thread/dictation-message-review.tsx", import.meta.url),
  "utf8"
);
const threadSource = await readFile(
  new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
  "utf8"
);

test("each reviewed bubble has its own user-triggered send action and inline status", () => {
  assert.match(reviewSource, /const sendOneMessage = async/);
  assert.match(reviewSource, /onClick=\{\(\) => void sendOneMessage\(message\)\}/);
  assert.match(reviewSource, /sendingMessageIds\.has\(message\.id\)/);
  assert.match(reviewSource, /sentMessageIds\.has\(message\.id\)/);
  assert.match(reviewSource, />\s*Sent\s*</);
});

test("an individually confirmed send greys only that bubble and refreshes the thread", () => {
  assert.match(reviewSource, /messageSent \? "opacity-60"/);
  assert.match(reviewSource, /const messageBusy = view === "sending" \|\| messageSending \|\| messageSent/);
  assert.match(reviewSource, /setSentMessageIds\(\(current\) => new Set\(current\)\.add\(message\.id\)\)/);
  assert.match(reviewSource, /onMessageSent\(\)/);
  assert.match(threadSource, /onMessageSent=\{\(\) => void refresh\(\)\}/);
  assert.match(threadSource, /onSendMessage=\{sendDictationMessage\}/);
});

test("individual sends can run independently without the composer's global send lock", () => {
  const start = threadSource.indexOf("const sendDictationMessage = useCallback");
  const end = threadSource.indexOf("// Cmd/Ctrl-Enter sends.", start);
  const block = threadSource.slice(start, end);
  assert.doesNotMatch(block, /sendingRef/);
  assert.doesNotMatch(block, /setSending/);
});

test("raw transcript and formatted messages stay editable without autosend", () => {
  assert.match(reviewSource, /aria-label="Raw transcript"/);
  assert.match(reviewSource, /value=\{rawTranscript\}/);
  assert.match(reviewSource, /onChange=\{\(event\) => setRawTranscript\(event\.target\.value\)\}/);
  assert.match(reviewSource, /\{ transcript: rawTranscript \}/);
  assert.match(reviewSource, /aria-label=\{`Message \$\{index \+ 1\}`\}/);
  assert.match(reviewSource, /onClick=\{\(\) => void sendMessages\(\)\}/);
  assert.doesNotMatch(reviewSource, /useEffect\(\(\) => \{\s*void sendMessages/);
});

test("successful sends become voice examples and formatter provenance is visible", () => {
  assert.match(reviewSource, /dictation-message-example/);
  assert.match(reviewSource, /messages: sentTexts/);
  assert.match(reviewSource, /messages: \[text\]/);
  assert.match(reviewSource, /Formatted with \{result\.source\.providerDisplayName\}, model \{result\.source\.model\}/);
});
