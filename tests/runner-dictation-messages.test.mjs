import test from "node:test";
import assert from "node:assert/strict";
import {
  assertVoiceFormattingRules,
  buildDictationMessagesUserPrompt,
  DICTATION_MESSAGES_EXAMPLES,
  DICTATION_MESSAGES_SYSTEM_PROMPT,
  fallbackSplitTranscript,
  sanitiseDictationMessagesResponse,
  stripTrailingFullStop
} from "../apps/runner/dist/services/dictation-messages.js";

// #880: pure contract for voice-preserving "Turn into messages".
// Prompt rules, response sanitiser, and fixtures from the issue body.

test("system prompt encodes voice-preservation and split-by-thought rules", () => {
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /formatting, not rewriting/i);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /basically/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /you know/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /icl/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /trailing full stops/i);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /And, But, Because, or So/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /natural thought/i);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /Never invent/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /Never rewrite informal/i);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /Prefer under-correction/i);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /cleanedTranscript/);
  assert.match(DICTATION_MESSAGES_SYSTEM_PROMPT, /warnings/);
});

test("buildDictationMessagesUserPrompt always includes the transcript", () => {
  const prompt = buildDictationMessagesUserPrompt({
    transcript: "  yeah I mean it was fine  "
  });
  assert.match(prompt, /Raw transcript:/);
  assert.match(prompt, /yeah I mean it was fine/);
  assert.match(prompt, /No extra name context/);
  assert.match(prompt, /Return JSON only/);
});

test("buildDictationMessagesUserPrompt includes optional person and known names", () => {
  const prompt = buildDictationMessagesUserPrompt({
    transcript: "hey toyvi",
    personName: "Tovi",
    knownNames: ["Richard", "  ", "Alex"]
  });
  assert.match(prompt, /Contact name \(for light name correction only\): Tovi/);
  assert.match(prompt, /Known names \(for light name correction only\): Richard, Alex/);
  assert.doesNotMatch(prompt, /No extra name context/);
});

test("stripTrailingFullStop removes a final period only", () => {
  assert.equal(stripTrailingFullStop("Hello there."), "Hello there");
  assert.equal(stripTrailingFullStop("Hello there?"), "Hello there?");
  assert.equal(stripTrailingFullStop("Wow!"), "Wow!");
  assert.equal(stripTrailingFullStop("Dr. Smith said hi."), "Dr. Smith said hi");
  assert.equal(stripTrailingFullStop("Already clean"), "Already clean");
  assert.equal(stripTrailingFullStop("ends with 。"), "ends with");
});

test("sanitiseDictationMessagesResponse returns null on unusable payload", () => {
  assert.equal(sanitiseDictationMessagesResponse(null, "raw"), null);
  assert.equal(sanitiseDictationMessagesResponse({}, "raw"), null);
  assert.equal(sanitiseDictationMessagesResponse({ messages: [] }, "raw"), null);
  assert.equal(sanitiseDictationMessagesResponse({ messages: ["  "] }, "raw"), null);
  assert.equal(sanitiseDictationMessagesResponse("not json object", "raw"), null);
});

test("sanitiseDictationMessagesResponse normalises ids, strips trailing stops, keeps warnings", () => {
  const out = sanitiseDictationMessagesResponse(
    {
      cleanedTranscript: "cleaned body",
      messages: [
        { id: "x", text: "Btw thanks for the help." },
        "Because icl I was stuck.",
        { text: "  " },
        { id: "ignored", text: "But your feedback helped a lot!" }
      ],
      warnings: [
        { originalText: "progress leaky", reason: "Unclear phrasing" },
        { originalText: "", reason: "" }
      ]
    },
    "original raw"
  );
  assert.ok(out);
  assert.equal(out.cleanedTranscript, "cleaned body");
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[0].id, "message-1");
  assert.equal(out.messages[0].text, "Btw thanks for the help");
  assert.equal(out.messages[1].id, "message-2");
  assert.equal(out.messages[1].text, "Because icl I was stuck");
  assert.equal(out.messages[2].text, "But your feedback helped a lot!");
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].originalText, "progress leaky");
  assert.deepEqual(assertVoiceFormattingRules(out), []);
});

test("sanitiseDictationMessagesResponse falls back cleanedTranscript to original", () => {
  const out = sanitiseDictationMessagesResponse(
    { messages: [{ text: "Yeah I mean, I feel alright" }] },
    "  Yeah I mean, I feel alright.  "
  );
  assert.ok(out);
  assert.equal(out.cleanedTranscript, "Yeah I mean, I feel alright.");
  assert.equal(out.messages[0].text, "Yeah I mean, I feel alright");
});

test("sanitise accepts example-shaped model outputs (issue fixtures)", () => {
  for (const example of DICTATION_MESSAGES_EXAMPLES) {
    const out = sanitiseDictationMessagesResponse(
      {
        cleanedTranscript: example.raw,
        messages: example.expectedMessages.map((text, i) => ({
          id: `message-${i + 1}`,
          text
        })),
        warnings: []
      },
      example.raw
    );
    assert.ok(out, `example ${example.id} should sanitise`);
    assert.equal(out.messages.length, example.expectedMessages.length, example.id);
    for (let i = 0; i < example.expectedMessages.length; i++) {
      assert.equal(out.messages[i].text, example.expectedMessages[i], `${example.id}[${i}]`);
      assert.doesNotMatch(out.messages[i].text, /[.。]\s*$/u, `${example.id}[${i}] trailing stop`);
    }
    // Conjunctions / filler the issue cares about should survive when present.
    const joined = out.messages.map((m) => m.text).join(" ");
    if (example.id === "thank-you-project") {
      assert.match(joined, /\bicl\b/i);
      assert.match(joined, /^Btw| Btw/i);
      assert.match(joined, /\bBecause\b/);
      assert.match(joined, /\bBut\b/);
      assert.match(joined, /\bAnd\b/);
    }
    if (example.id === "tovi-app") {
      assert.match(joined, /basically/i);
      assert.match(joined, /obviously/i);
      assert.match(joined, /you know/i);
      assert.match(joined, /I think/i);
      assert.match(joined, /I guess/i);
    }
    if (example.id === "on-to-the-next") {
      assert.match(joined, /I mean/i);
      assert.match(joined, /\?/);
    }
    assert.deepEqual(assertVoiceFormattingRules(out), []);
  }
});

test("fallbackSplitTranscript never invents wording and strips trailing stops", () => {
  const raw =
    "Yeah, I mean, I feel alright. It's okay, man. That's how life goes!";
  const out = fallbackSplitTranscript(raw);
  assert.ok(out.messages.length >= 2);
  const joined = out.messages.map((m) => m.text).join(" ");
  assert.match(joined, /Yeah/);
  assert.match(joined, /alright/);
  assert.match(joined, /life goes/);
  assert.deepEqual(assertVoiceFormattingRules(out), []);
  // Every non-empty token of the original (roughly) should appear somewhere;
  // fallback is split-only, not rewrite.
  for (const word of ["Yeah", "mean", "alright", "okay", "life", "goes"]) {
    assert.match(joined, new RegExp(word, "i"));
  }
});

test("fallbackSplitTranscript on empty input returns empty messages", () => {
  const out = fallbackSplitTranscript("   ");
  assert.equal(out.messages.length, 0);
  assert.equal(out.cleanedTranscript, "");
});

test("issue examples fixtures are present and non-empty", () => {
  assert.equal(DICTATION_MESSAGES_EXAMPLES.length, 3);
  for (const ex of DICTATION_MESSAGES_EXAMPLES) {
    assert.ok(ex.raw.length > 20);
    assert.ok(ex.expectedMessages.length >= 3);
  }
});
