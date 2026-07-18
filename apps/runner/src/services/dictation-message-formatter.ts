import { z } from "zod";
import type { DictationMessageFormatting } from "../types/runtime";

const formatterResponseSchema = z
  .object({
    cleanedTranscript: z.string().trim().min(1).max(12_000),
    messages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            text: z.string().trim().min(1).max(4_000)
          })
          .strict()
      )
      .min(1)
      .max(40),
    warnings: z
      .array(
        z
          .object({
            originalText: z.string().trim().min(1).max(500),
            reason: z.string().trim().min(1).max(500)
          })
          .strict()
      )
      .max(20)
  })
  .strict();

export const DICTATION_MESSAGE_FORMATTER_SYSTEM_PROMPT = `You format a raw speech transcript into natural chat messages written in the speaker's own voice. This is formatting, not rewriting.

Preserve the speaker's meaning, tone, slang, abbreviations, filler, vocabulary, rhythm, uncertainty, and level of formality. Keep phrases such as basically, obviously, I mean, you know, I think, I guess, yeah, btw, icl, tbf, Yhh, but, and, because, and so when they are intentional. Messages may begin with And, But, Because, or So.

Correct only obvious transcription mistakes when the intended wording is reasonably clear. Never invent information, silently guess an uncertain name or phrase, formalise informal English, or make the speaker more polished, concise, confident, or professional. Prefer under-correction over polish. Put genuinely uncertain wording in warnings.

Split by natural thought, not mechanically at punctuation. Each item should feel like one message the speaker would realistically send. Keep related phrases together and avoid lots of tiny messages unless the speaker's style calls for them. A message may contain more than one sentence.

Use normal capitalisation. Remove trailing full stops from every message. Preserve question marks and exclamation marks when genuinely needed. Preserve names, numbers, links, technical terms, and personal abbreviations.

Return only one JSON object matching the requested shape. Do not include markdown or commentary.`;

const EXAMPLES = [
  {
    transcript:
      "Btw I just wanted to say thank you for helping me with the project because icl I was honestly quite stuck and I didn’t really know what I was doing but your feedback helped a lot and yeah I’ll probably send the updated version tomorrow",
    messages: [
      "Btw I just wanted to say thank you for helping me with the project",
      "Because icl I was honestly quite stuck and I didn’t really know what I was doing",
      "But your feedback helped a lot",
      "And Yhh I’ll probably send the updated version tmr"
    ]
  },
  {
    transcript:
      "Okay, cool. So, basically what I was doing yesterday was I was working on the Toyvi app because, obviously, what do you call it, we're trying to make it so that instead of just being able to access it on Mac, you can also access it on iPhone. So obviously that's a really important feature to us to actually make it accessible to most people. I think once we can get it to that point, that's when we can, you know, that's when we'll be cooking. I think that'll also make it like a minimum viable product as well. So I think that's like the progress leaky from what we've been able to do so far. And I guess I'm just excited to see, you know, where it goes. But yeah, I think that's basically it.",
    messages: [
      "Okay cool, so basically what I was doing yesterday was working on the Tovi app",
      "Because obviously we’re trying to make it so that instead of only being able to access it on Mac, you can also access it on iPhone",
      "So obviously that’s a really important feature for us, just to actually make it accessible to most people",
      "I think once we can get it to that point, that’s when we’ll be cooking",
      "I think that’ll also make it like a minimum viable product as well",
      "So I think that’s basically the progress we’ve made so far",
      "And I guess I’m just excited to see, you know, where it goes",
      "But yeah, I think that’s basically it"
    ]
  },
  {
    transcript:
      "Yeah, I mean, I feel alright. It's okay, man. I'd like to have done a little bit better. I was on the edge, but listen, what can we do, man? That's how life goes. Life is on to the next thing, I'll be real. On to the next thing.",
    messages: [
      "Yeah I mean, I feel alright",
      "It’s okay man, I would’ve liked to have done a little bit better",
      "I was on the edge, but listen, what can we do man?",
      "That’s how life goes",
      "I’ll be real, it’s on to the next thing now"
    ]
  }
];

function stripTrailingFullStops(text: string): string {
  return text.trim().replace(/\.+$/u, "").trimEnd();
}

export function parseDictationMessageFormatting(value: unknown): DictationMessageFormatting {
  const parsed = formatterResponseSchema.parse(value);
  const messages = parsed.messages.map((message, index) => {
    const text = stripTrailingFullStops(message.text);
    if (!text) {
      throw new Error(`Formatted message ${index + 1} is empty after validation`);
    }
    return { id: `message-${index + 1}`, text };
  });
  return {
    cleanedTranscript: parsed.cleanedTranscript,
    messages,
    warnings: parsed.warnings
  };
}

export function buildDictationMessageFormatterPrompt(input: {
  transcript: string;
  contactName?: string | null;
}): string {
  const context = input.contactName?.trim()
    ? `The conversation is with ${JSON.stringify(input.contactName.trim())}. Use this only to correct a clearly mis-transcribed version of that name. Do not add the name if the speaker did not say it.`
    : "No verified contact name is available. Do not guess names.";
  return `Format the transcript below into natural message bubbles.

${context}

Return strict JSON with this exact shape:
{
  "cleanedTranscript": "A lightly corrected version of the original transcript",
  "messages": [
    { "id": "message-1", "text": "First natural message" }
  ],
  "warnings": [
    { "originalText": "Unclear words", "reason": "Why the intended wording could not be confirmed" }
  ]
}

Examples:
${JSON.stringify(EXAMPLES)}

Raw transcript:
${JSON.stringify(input.transcript)}`;
}
