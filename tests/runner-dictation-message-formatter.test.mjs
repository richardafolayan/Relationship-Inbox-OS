import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDictationMessageFormatterPrompt,
  DICTATION_MESSAGE_FORMATTER_SYSTEM_PROMPT,
  parseDictationMessageFormatting,
  resolveDictationFormatterTarget
} from "../apps/runner/dist/services/dictation-message-formatter.js";

const examples = [
  [
    "Btw I just wanted to say thank you for helping me with the project because icl I was honestly quite stuck and I didn’t really know what I was doing but your feedback helped a lot and yeah I’ll probably send the updated version tomorrow",
    [
      "Btw I just wanted to say thank you for helping me with the project",
      "Because icl I was honestly quite stuck and I didn’t really know what I was doing",
      "But your feedback helped a lot",
      "And Yhh I’ll probably send the updated version tmr"
    ]
  ],
  [
    "Okay, cool. So, basically what I was doing yesterday was I was working on the Toyvi app because, obviously, what do you call it, we're trying to make it so that instead of just being able to access it on Mac, you can also access it on iPhone.",
    [
      "Okay cool, so basically what I was doing yesterday was working on the Tovi app",
      "Because obviously we’re trying to make it so that instead of only being able to access it on Mac, you can also access it on iPhone",
      "So obviously that’s a really important feature for us, just to actually make it accessible to most people",
      "I think once we can get it to that point, that’s when we’ll be cooking",
      "I think that’ll also make it like a minimum viable product as well",
      "So I think that’s basically the progress we’ve made so far",
      "And I guess I’m just excited to see, you know, where it goes",
      "But yeah, I think that’s basically it"
    ]
  ],
  [
    "Yeah, I mean, I feel alright. It's okay, man. I'd like to have done a little bit better. I was on the edge, but listen, what can we do, man? That's how life goes. Life is on to the next thing, I'll be real. On to the next thing.",
    [
      "Yeah I mean, I feel alright",
      "It’s okay man, I would’ve liked to have done a little bit better",
      "I was on the edge, but listen, what can we do man?",
      "That’s how life goes",
      "I’ll be real, it’s on to the next thing now"
    ]
  ]
];

test("the issue examples satisfy the strict message contract without losing voice markers", () => {
  for (const [transcript, messages] of examples) {
    const parsed = parseDictationMessageFormatting({
      cleanedTranscript: transcript,
      messages: messages.map((text, index) => ({ id: `model-${index}`, text: `${text}.` })),
      warnings: []
    });
    assert.deepEqual(parsed.messages.map((message) => message.text), messages);
    assert.ok(parsed.messages.every((message) => !message.text.endsWith(".")));
  }
});

test("question marks and exclamation marks survive while trailing full stops are removed", () => {
  const parsed = parseDictationMessageFormatting({
    cleanedTranscript: "But what can we do? Yeah! And then we move.",
    messages: [
      { id: "a", text: "But what can we do?" },
      { id: "b", text: "Yeah!" },
      { id: "c", text: "And then we move..." }
    ],
    warnings: []
  });
  assert.deepEqual(parsed.messages.map((message) => message.text), [
    "But what can we do?",
    "Yeah!",
    "And then we move"
  ]);
});

test("every formatted message and sentence starts with a capital letter", () => {
  const parsed = parseDictationMessageFormatting({
    cleanedTranscript: "yeah that makes sense. i can do tomorrow. are you free after six? perfect!",
    messages: [
      { id: "a", text: "yeah that makes sense. i can do tomorrow." },
      { id: "b", text: "are you free after six? perfect!" },
      { id: "c", text: "“i'll confirm later.” then i'll let you know." }
    ],
    warnings: []
  });
  assert.deepEqual(parsed.messages.map((message) => message.text), [
    "Yeah that makes sense. I can do tomorrow",
    "Are you free after six? Perfect!",
    "“I'll confirm later.” Then i'll let you know"
  ]);
});

test("invalid model output is rejected instead of being displayed", () => {
  assert.throws(() =>
    parseDictationMessageFormatting({
      cleanedTranscript: "hello",
      messages: [],
      warnings: []
    })
  );
  assert.throws(() =>
    parseDictationMessageFormatting({
      cleanedTranscript: "hello",
      messages: [{ id: "a", text: "hello", invented: true }],
      warnings: []
    })
  );
});

test("the prompt pins final intent, meaning-safe compression, natural splitting, and verified-name context", () => {
  const prompt = buildDictationMessageFormatterPrompt({
    transcript: "Toyvi is cooking",
    contactName: "Tobi",
    operatorProfile: {
      displayName: "Richard",
      about: "Informal and direct",
      preferredStyle: "casual",
      commonPhrases: "icl\nbut yeah",
      avoidedPhrases: "I hope this finds you well",
      acceptedExamples: [
        { messages: ["Icl I was quite stuck", "But yeah, your feedback helped a lot"] }
      ]
    },
    recentInbound: {
      messageCount: 2,
      totalCharacters: 84,
      averageCharacters: 42
    }
  });
  const rules = `${DICTATION_MESSAGE_FORMATTER_SYSTEM_PROMPT}\n${prompt}`;
  for (const phrase of [
    "final intended meaning",
    "Compress repetition without compressing meaning",
    "earlier statements that the speaker clearly corrects or replaces",
    "Prefer fewer, fuller bubbles",
    "soft proportionality signal",
    "Do not mechanically delete subjects",
    "Start every message and every sentence with a capital letter",
    "Remove trailing full stops",
    "Do not add the name if the speaker did not say it",
    "warnings"
  ]) {
    assert.match(rules, new RegExp(phrase, "i"));
  }
  assert.match(prompt, /"displayName":"Richard"/);
  assert.match(prompt, /"preferredStyle":"casual"/);
  assert.match(prompt, /"commonPhrases":"icl\\nbut yeah"/);
  assert.match(prompt, /"priorAcceptedOutputs":\[\["Icl I was quite stuck"/);
  assert.match(prompt, /"messageCount":2/);
  assert.doesNotMatch(prompt, /nearby inbound message text/i);
});

test("the formatter target stays on the selected provider and model", () => {
  const defaults = {
    aiProvider: "openai",
    openAiModel: "gpt-5-nano",
    glmModel: "glm-4.7-flash",
    geminiModel: "gemma-4-31b-it"
  };
  assert.deepEqual(
    resolveDictationFormatterTarget({
      settings: { aiProvider: "gemini", geminiModel: "gemma-3-27b-it" },
      defaults
    }),
    { providerId: "gemini", model: "gemma-3-27b-it" }
  );
  assert.deepEqual(
    resolveDictationFormatterTarget({
      settings: { aiProvider: "glm", glmModel: "  " },
      defaults
    }),
    { providerId: "glm", model: "glm-4.7-flash" }
  );
});
