import { z } from "zod";
import type { AiProvider } from "@inbox-os/core";
import type {
  DictationMessageFormatting,
  DictationVoiceProfile
} from "../types/runtime";

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

export const DICTATION_MESSAGE_FORMATTER_SYSTEM_PROMPT = `Turn a raw speech transcript into natural chat messages that express the speaker's final intended meaning in their own voice.

Preserve every distinct claim, qualifier, reason, opinion, emotional nuance, tone, level of formality, and genuine topic change. Compress repetition without compressing meaning. Remove only false starts, abandoned clauses, filler-only fragments, semantically duplicated wording, and earlier statements that the speaker clearly corrects or replaces. Once a contradiction is clearly resolved, keep only the final intended version. Never turn the transcript into a generic summary.

Keep useful conversational phrasing, slang, contractions, abbreviations, vocabulary, rhythm, and uncertainty when they contribute to voice or flow. Natural phrasing may include don't, haven't, I'm, I've, gonna, because, and, but, to be fair, you know, then, also, but yeah, or to be honest when supported by the transcript or the operator's voice profile. The voice profile controls style only. It never supplies facts, reasons, opinions, certainty, emotional framing, or recipient context.

Vary repetitive openings naturally according to chronology, addition, contrast, emphasis, and topic movement. Do not mechanically delete subjects or rotate opening phrases. Subjectless fragments are acceptable only when they sound natural and remain clear. Add light connective wording only when it is clearly implied. Use a natural pivot when the speaker genuinely changes topic.

Prefer fewer, fuller bubbles when adjacent clauses express one complete thought. Keep separate bubbles only for a real change of thought, purpose, emphasis, or topic. Do not split mechanically at every sentence or connective, and do not enforce a fixed bubble cap. Nearby inbound message count and length are only a soft proportionality signal and never permission to omit meaning.

Correct obvious transcription mistakes only when the intended wording is reasonably clear. Never invent information, silently guess an uncertain name or phrase, formalise informal English, or make the speaker more polished, confident, or professional than intended. Put genuinely uncertain wording in warnings.

Use normal capitalisation. Remove trailing full stops from every message. Preserve genuine question marks and exclamation marks. Preserve names, numbers, links, technical terms, and personal abbreviations.

Return only one JSON object matching the requested shape. Do not include markdown or commentary.`;

const EXAMPLES = [
  {
    transcript:
      "I'm probably gonna do this thing and that thing. Actually no, not that, I'm probably just gonna do X, Y, Z.",
    messages: [
      "I'm probably just gonna do X, Y, Z"
    ]
  },
  {
    transcript:
      "I still need to go to the gym which is really important. I need to do a lot of business work after that. I feel like I haven't been contributing to the business as much as I should to be honest so I need to do better with that. I need to apply for a new job. I need to probably do some Java learning.",
    messages: [
      "I still need to go to the gym, which is really important",
      "Then after that, I need to do a lot of business work",
      "I feel like I haven't been contributing to the business as much as I should, to be honest, so I need to do better with that",
      "Also need to apply for a new job",
      "Then probably do some Java learning"
    ]
  },
  {
    transcript:
      "Btw thank you for helping me with the project because icl I was honestly quite stuck and your feedback helped a lot. Oh and completely separate but are you still going Birmingham this weekend because I might be there Sunday.",
    messages: [
      "Btw thank you for helping me with the project because icl I was honestly quite stuck, but your feedback helped a lot",
      "Completely separate, but are you still going Birmingham this weekend? I might be there Sunday"
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
  operatorProfile?: DictationVoiceProfile | null;
  recentInbound?: {
    messageCount: number;
    totalCharacters: number;
    averageCharacters: number;
  } | null;
}): string {
  const context = input.contactName?.trim()
    ? `The conversation is with ${JSON.stringify(input.contactName.trim())}. Use this only to correct a clearly mis-transcribed version of that name. Do not add the name if the speaker did not say it.`
    : "No verified contact name is available. Do not guess names.";
  const profile = input.operatorProfile
    ? JSON.stringify({
        displayName: input.operatorProfile.displayName,
        selfDescription: input.operatorProfile.about,
        preferredStyle: input.operatorProfile.preferredStyle,
        commonPhrases: input.operatorProfile.commonPhrases,
        avoidedPhrases: input.operatorProfile.avoidedPhrases,
        priorAcceptedOutputs: input.operatorProfile.acceptedExamples.map((example) => example.messages)
      })
    : "No operator voice profile is available. Use only the transcript's own voice cues.";
  const inbound = input.recentInbound
    ? JSON.stringify(input.recentInbound)
    : "No nearby inbound-message proportions are available.";
  return `Turn the transcript below into final-intent message bubbles.

${context}

Operator voice profile, style guidance only:
${profile}

Nearby inbound-message proportions, soft bubble-count signal only:
${inbound}

Return strict JSON with this exact shape:
{
  "cleanedTranscript": "The cleaned final-intent transcript with superseded wording removed",
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

export function resolveDictationFormatterTarget(input: {
  settings: {
    aiProvider?: AiProvider;
    glmModel?: string;
    geminiModel?: string;
  };
  defaults: {
    aiProvider: AiProvider;
    openAiModel: string;
    glmModel: string;
    geminiModel: string;
  };
}): { providerId: AiProvider; model: string } {
  const providerId = input.settings.aiProvider ?? input.defaults.aiProvider;
  const model =
    providerId === "glm"
      ? input.settings.glmModel?.trim() || input.defaults.glmModel
      : providerId === "gemini"
        ? input.settings.geminiModel?.trim() || input.defaults.geminiModel
        : input.defaults.openAiModel;
  return { providerId, model };
}
