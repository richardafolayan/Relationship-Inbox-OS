import OpenAI from "openai";
import type { PlatformName, SummaryOutput, SuggestedRepliesOutput, AiSource } from "@inbox-os/core";
import { z } from "zod";
import { runnerConfig, type AiProvider } from "../config";
import { safeTruncate, stripUnpairedSurrogates } from "../platforms/utils";
import type {
  AiService,
  ContactProfileSnapshot,
  ConversationStartersOutput,
  ConversationStarterCitedField,
  FriendshipSummaryOutput,
  OperatorProfile,
  PilotReportTriage,
  SettingsStore
} from "../types/runtime";
import {
  providerRegistry,
  fallbackChain,
  classifyLlmError as classifyLlmErrorImpl,
  type AiErrorClassification
} from "./ai-providers";

// Re-exported so existing tests + callers continue to import from ai.ts.
export const classifyLlmError = classifyLlmErrorImpl;

const summarySchema = z.object({
  summary: z.string(),
  what_they_want: z.string(),
  open_loops: z.array(z.string()),
  tone_notes: z.array(z.string()).default([]),
  needs_reply: z.boolean(),
  urgency_hint: z.string().optional()
});

// Provider error classification + retry/fallback configuration lives in
// ./ai-providers. Adding a new AI provider: extend the `AiProvider` union
// in ../config and add an entry to `providerRegistry`. See the file
// header in ai-providers.ts for details.

const repliesSchema = z.object({
  replies: z.array(
    z.object({
      label: z.enum(["A", "B", "C"]),
      intent: z.string(),
      text: z.string()
    })
  ),
  needs_user_input: z.array(z.string()).default([])
});

const categorySchema = z.object({
  category: z.enum(["outreach", "genuine"])
});

// #287 phase 2.5. The conversation-end verdict. "closed" means the most
// recent inbound reads as a natural endpoint and no reply is owed.
// "open" means the operator still owes a reply. There is no third
// "ambiguous" tier: ambiguous threads default to "open" so the operator
// is never quietly nudged out of a conversation that might need them.
const closedStatusSchema = z.object({
  status: z.enum(["closed", "open"])
});

const friendshipSummarySchema = z.object({
  how_you_know_each_other: z.string(),
  recent_topics: z.array(z.string()).default([]),
  inside_jokes: z.array(z.string()).default([]),
  vibe: z.string()
});

const askAboutPersonSchema = z.object({
  answer: z.string()
});

// Voice + style rules applied to every AI generation (summary, suggested
// replies, transformReply, classifier). Centralised so a tweak is one edit.
// Three constraints in particular drive the rest of the prompts in this file:
//   - 1-2 sentence outputs (informs prompt examples + zod max-length checks)
//   - No em-dashes / en-dashes / semicolons / colons (post-processing strips
//     these to handle GPT-5 occasionally slipping them in)
//   - Match inbound register (downstream prompts pass the inbound text so the
//     model can see the tone to mirror)
export const SYSTEM_PROMPT = [
  "You are a concise relationship assistant. Use British English. Keep outputs practical, calm, and grounded in evidence.",
  "",
  "- Conversational and direct, like talking to a peer. No corporate filler or marketing clichés like \"I noticed\".",
  "- No em dashes or en dashes.",
  "- No semicolons, or colons.",
  "- Match the inbound message's length and register. Aim for within ±50% of the inbound's word count: a one-line ack gets a one-line reply, a paragraph gets a paragraph. Warm if they're warm, formal if they're formal.",
  "- Deviate from the length match when context warrants. A one-line question (\"are you free tomorrow?\") sometimes deserves a slightly longer answer that actually answers the question (\"sorry, tied up Tuesday but Wednesday works\") rather than a one-liner that doesn't. Substance over symmetry.",
  "- Default to 1-2 sentences when in doubt; longer is fine when the inbound is longer or when answering requires it.",
  "",
  "ATTRIBUTION DISCIPLINE (strict). When messages are presented with role labels:",
  "- Lines / messages prefixed `operator:` were written by the OPERATOR (the person you are assisting). Never paraphrase, summarise, or attribute these to the contact.",
  "- Lines / messages prefixed `contact:` were written by the OTHER PERSON in the thread. Never paraphrase or attribute these to the operator.",
  "- The same rule applies if you see `direction: \"OUT\"` (operator) or `direction: \"IN\"` (contact) on a message object. \"OUT\" = the operator wrote it; \"IN\" = the contact wrote it.",
  "- When summarising or quoting, keep the speaker straight. If the operator already said something, that is not a question the contact is asking. If the contact made a request, that is not the operator's intent.",
  "",
  "If the inbound is a sales pitch, recruitment outreach, marketing, InMail, or cold solicitation, replace the \"Clarifying question\" reply with a \"Polite decline\" (a short, friendly \"not interested\" reply, ~1 sentence)."
].join("\n");

// Voice profile tier — picks between the formal (professional) prompt and
// the casual-DM prompt based on platform. Casual covers WhatsApp / iMessage
// / Instagram / TikTok DMs; LinkedIn uses the professional register. Both
// tiers are generic scaffolds — the operator's actual voice comes from
// their configured profile, injected via operatorProfileFragment(). With
// no profile set, both tiers fall back to a plain, neutral voice.
type VoiceTier = "formal" | "casual";

export function getVoiceTier(platform: PlatformName): VoiceTier {
  if (platform === "LINKEDIN") return "formal";
  return "casual";
}

export function selectVoicePrompt(platform: PlatformName): string {
  return getVoiceTier(platform) === "formal" ? FORMAL_VOICE_PROMPT : CASUAL_VOICE_PROMPT;
}

// Platform-appropriate noun used in the composeInVoice user prompt
// ("sendable X message"). LinkedIn keeps its specific name to preserve
// byte-identical formal-tier output; everything else falls through to a
// generic "message" so the casual system prompt's register dominates.
function platformMessageNoun(platform: PlatformName): string {
  return platform === "LINKEDIN" ? "LinkedIn message" : "message";
}

// Formal voice profile (LinkedIn / professional). A GENERIC scaffold — it
// describes how to write well without impersonating anyone. The current
// user's actual voice is injected separately via operatorProfileFragment()
// (the "WRITE AS THIS PERSON" block in the user message). With no profile
// configured, this scaffold alone produces a plain, neutral, friendly
// register. It must never assume a specific identity, slang set, or
// nationality.
const FORMAL_VOICE_PROMPT = [
  "You are helping the operator write a professional message (LinkedIn-style) in their OWN voice. Conversational and peer-to-peer, never corporate or salesy.",
  "",
  "WHOSE VOICE",
  "- If the user message includes a \"WRITE AS THIS PERSON\" block, that is the operator's configured voice profile. Follow it closely: their name, how they describe their own messaging style, their preferred tone, the words they use, the words they avoid.",
  "- If there is no such block, write in a plain, natural, friendly style. Do NOT invent a persona, slang, accent, or identity details. Do not imitate any particular person.",
  "",
  "VOICE PRINCIPLES",
  "- Match the length and energy of their message. A short acknowledgement gets a short reply. A long, thoughtful message earns a longer, thoughtful reply.",
  "- Where it fits naturally, ask one genuine question grounded in what they actually said or in their profile. The goal is finding common ground and making them feel comfortable.",
  "- Warm and human. No marketing clichés, no hype-affirmation (\"smashing it\", \"killing it\", \"crushing it\"), no \"I noticed\".",
  "- Contractions are normal (\"I'm\", \"it's\", \"you're\"). Don't write stiffly.",
  "",
  "OUTPUT RULES",
  "- Don't introduce deliberate typos, and don't over-polish into something stiff and corporate. Aim for a natural conversational register.",
  "- HARD RULE — sentence starts get a capital letter. After every full stop, question mark, or exclamation mark, the next character that starts the next sentence MUST be uppercase. \". sounds like\" or \"? what are you\" is a fail. Read your output back and check before returning.",
  "- When unsure how long the reply should be, err shorter. Long replies should feel earned by the depth of what they said.",
  "- No em dashes, en dashes, semicolons, or colons.",
  "- Don't end with a question if the situation doesn't warrant one. A polite decline is acknowledgement-only, no follow-up question.",
  "- HALLUCINATION GUARD (strict). ONLY use details that are literally in their message or in the thread history. The test: if you can't quote the relevant phrase back from their text, don't include it. \"Enjoying it\" does NOT license \"new job\", \"steep learning curve\", or any other invented context, even if it sounds plausible. Stick to the words they actually used or close synonyms. Don't invent job context, emotional context, motivations, or backstory. Don't add compliments they didn't earn. Phrases like \"appreciate you sticking with it\", \"glad you reached out\", \"thanks for being patient\" are forbidden unless they said something that warrants them. If you're tempted to add warmth or context that isn't grounded in what they wrote, cut it. Words drawn from the operator's configured voice profile are register, not claims about the recipient, and are exempt from this guard.",
  "- If a name is used, put it at the start in the \"Hey [name],\" form. Do NOT embed names mid-sentence. The name can be omitted entirely where the message reads more naturally without it.",
  "- Don't greet by name unless the intent calls for it.",
  "- If a late-reply acknowledgement is requested, phrase it naturally, not as a templated apology."
].join("\n");

// Outreach-vs-genuine classifier prefix for the formal (LinkedIn) tier.
// The full prompt is this prefix + a per-thread suffix (person name,
// summary, what-they-want, inbound message excerpts). Returned categories
// stay "outreach" | "genuine" across both tiers — only the definitions and
// examples differ — so the dashboard category filter, the schema, and
// existing data all keep working unchanged.
const FORMAL_CLASSIFY_PROMPT_PREFIX = `Classify this LinkedIn thread as either:

  "outreach" — cold pitches with an EXPLICIT transactional move. The
              giveaway is a concrete ASK directed at me (book a call,
              hop on a chat, are you already working with X, can I send
              you a deck, here's a discount, fill out this form). Cold
              recruiters, sponsored InMails, agency / SaaS / financial-
              adviser pitches, lead-gen scripts that pivot from a
              compliment to a service offer. The motive must be
              actionable, not just present.

  "genuine" — peer chats, ongoing relationships, friends, classmates,
             ex-colleagues, customers, mentors, or anyone introducing
             themselves and their work without a transactional ask. A
             person describing what they do and saying things like
             "open to sharing ideas if relevant", "happy to chat if
             useful", "let me know if interesting" is GENUINE — they
             are positioning, not selling.

Decision rules (apply in order):
  1. If the inbound contains an EXPLICIT ask to act ("book a 15-min
     call?", "are you already working with an accountant?", "can I send
     a proposal?", "fill out this form") → OUTREACH.
  2. If a friendly opener is followed within 1-2 messages by such an
     explicit ask → OUTREACH.
  3. If the person describes their commercial work but only offers
     soft, optional engagement ("open to sharing ideas if relevant",
     "happy to swap notes", "let me know if useful") with NO
     transactional ask → GENUINE.
  4. If the rolling summary already characterises them as "open to
     sharing", "introduces themselves", "describes their work",
     without flagging a pitch / ask / service offer → GENUINE.
  5. Two-way conversation with no sales motive → GENUINE.
  6. A brief one-line greeting with nothing else → GENUINE.
  7. When ambiguous and there is no explicit ask in the messages →
     GENUINE. Default to genuine unless the pitch is unmistakable.

Examples:
  GENUINE — "Hey, I work in data analytics helping businesses use
            their data better. Open to sharing ideas if relevant."
  GENUINE — "Saw your post about X, really resonated. I run a small
            studio doing similar work. Always up for a chat if useful."
  OUTREACH — "Hi, I help founders cut tax bills. Are you already
            working with an accountant?"
  OUTREACH — "Quick one — would you be open to a 15-min call this week
            to see if we're a fit?"

Return strict JSON: { "category": "outreach" | "genuine" }`;

// Casual classifier prefix. Casual platforms (WhatsApp / iMessage /
// Instagram DM / TikTok DM) have a different outreach pattern: most
// chats are saved-contact conversations (genuine), and outreach shows
// up as automated business broadcasts, marketing SMS, scam/phishing
// attempts, or cold DMs from strangers pitching a service. The output
// shape is identical to the formal prefix so the dashboard category
// filter and Thread.category storage are unchanged.
const CASUAL_CLASSIFY_PROMPT_PREFIX = `Classify this messaging-app thread (WhatsApp / iMessage / Instagram DM / TikTok DM) as either:

  "outreach" — promotional broadcasts, automated business
              notifications, marketing SMS, scam or phishing attempts,
              spam, or unsolicited transactional contact from someone
              the operator has no ongoing relationship with. Examples:
              "Vodafone: Top up offer", "URGENT: your delivery has
              been delayed — click here to confirm", recruiter cold
              DMs, "We saw your profile — interested in our SaaS?",
              cold strangers asking the operator to book a call /
              fill a form / accept an offer. The giveaway is bulk /
              automated tone, no personal context, or a hard sales
              ask from someone unknown.

  "genuine" — a real conversation with a saved or known contact —
             friends, family, mates, ex-colleagues, ongoing chats —
             including casual banter, plans, logistics, check-ins, or
             commercial talk between people who actually know each
             other. Saved contacts texting normally are GENUINE even
             when the topic is transactional ("hop on a call about
             the project") — the relationship is the giveaway, not
             the topic.

Decision rules (apply in order):
  1. Tone is automated / bulk / generic (no proper name, "Dear
     customer", suspicious shortlink, urgent CTA, template-shaped
     phrasing) → OUTREACH.
  2. Sender is a saved or recurring contact and the conversation is
     two-way → GENUINE.
  3. Cold first message from a stranger pitching a product, service,
     job, or opportunity → OUTREACH.
  4. Casual short greetings, banter, plans, logistics, check-ins from
     a known contact → GENUINE.
  5. When ambiguous, default to GENUINE — only flag outreach when the
     pitch / spam / automation pattern is unmistakable.

Examples:
  GENUINE — "yo what time you free tomorrow"
  GENUINE — "hey mate can you send me that link again"
  GENUINE — "can we hop on a call about the project" (from a known contact)
  OUTREACH — "Hi! We help founders scale to 7-figures. Interested in a quick call?"
  OUTREACH — "URGENT: Your account has been flagged. Verify now: bit.ly/abc"
  OUTREACH — "Hi there! Top up your line this weekend and get 5GB free."

Return strict JSON: { "category": "outreach" | "genuine" }`;

export function selectClassifyPromptPrefix(platform: PlatformName): string {
  return getVoiceTier(platform) === "formal" ? FORMAL_CLASSIFY_PROMPT_PREFIX : CASUAL_CLASSIFY_PROMPT_PREFIX;
}

// Conversation-end classifier (#287 phase 2.5). The dashboard has a
// lightweight regex heuristic for obvious closes (bare "thanks", "ok",
// emoji reactions, farewells with no question). This prompt is the
// ambiguous-middle pass: the messages that look closing-ish but the
// regex cannot confidently decide on. The model's job is to mirror how
// a human reads the last beat of the thread, not to second-guess the
// operator.
export const CLOSED_STATUS_PROMPT = `Decide whether this conversation has wrapped up or whether the operator still owes a reply.

Definitions:
  "closed" — the most recent inbound is a natural endpoint with no
            implicit ask. Acknowledgements (thanks, got it, perfect,
            noted), farewells (talk soon, take care, have a good
            one), wrap statements (cool, sounds good), or short
            reactions (a heart, a thumbs up, "lol"). The conversation
            has finished its current arc and no reply is owed.

  "open"   — the most recent inbound expects something from the
            operator: a question, an explicit ask, a future plan that
            needs confirming, a statement that obviously invites a
            response. If the inbound restarts the conversation after
            a lull ("hey, been a while, how are you?") that is OPEN.
            If the operator was the last to speak and the conversation
            is mid-flight, that is OPEN.

Decision rules (apply in order):
  1. If the latest message includes a question mark or an explicit
     ask ("can you", "let me know", "thoughts?", "what time", "pls"),
     → OPEN.
  2. If the latest inbound is a short acknowledgement / wrap with no
     follow-up beat → CLOSED.
  3. If the latest inbound is a farewell ("talk soon", "have a good
     one", "catch up soon") → CLOSED.
  4. If the latest inbound mentions future plans needing the operator
     to confirm or coordinate ("let's grab coffee next week", "I'll
     send the deck Monday — sound good?") → OPEN.
  5. If the operator (direction OUT) was last to speak, the thread is
     waiting on them, → OPEN.
  6. When in doubt → OPEN. False "closed" hides threads that might
     need the operator; false "open" just leaves them visible.

Examples:
  CLOSED — IN: "thanks so much, really appreciate it"
  CLOSED — IN: "perfect, see you Wednesday"
  CLOSED — IN: "👍"
  OPEN   — IN: "thanks - and one more thing, did the invoice clear?"
  OPEN   — IN: "hey, been ages! how have you been?"
  OPEN   — IN: "I'll send the doc later today, sound good?"
  OPEN   — OUT: "let me know what you think"

Return strict JSON: { "status": "closed" | "open" }`;

// Casual-DM voice profile. Applies on WhatsApp / iMessage / Instagram /
// TikTok DMs. A GENERIC scaffold: it sets the relaxed register without
// impersonating anyone. The current user's actual voice — their slang,
// emoji habits, phrasing — comes only from their configured profile,
// injected via operatorProfileFragment(). With no profile set, this
// produces a plain, natural, everyday casual style. It must never assume
// a specific identity, slang set, emoji palette, or nationality.
const CASUAL_VOICE_PROMPT = `You are helping the operator write a casual message (WhatsApp, iMessage, Instagram DM, or TikTok DM) in their OWN voice — the relaxed, everyday register they would use with people they know.

WHOSE VOICE
- If the user message includes a "WRITE AS THIS PERSON" block, that is the operator's configured voice profile. Follow it closely: their name, how they describe their own messaging style, their preferred tone, the words and phrases they use, the words and phrases they avoid, and any emoji habit they describe.
- If there is no such block, write in a plain, natural, friendly, everyday casual style. Do NOT invent slang, an accent, an emoji habit, or any identity details. Do not imitate any particular person.

STRUCTURE
- Casual and conversational. Keep it short and relaxed — this is a text message, not an email.
- HARD RULE — sentence starts get a capital letter. After a full stop, question mark, or exclamation mark, the next sentence starts with an uppercase letter. A mid-sentence lowercase "i" pronoun is fine if the operator's profile writes that way; the rule is only about sentence starts.

EMOJI
- Default to no emoji. Most casual messages do not need one.
- Only add an emoji if the operator's configured profile shows they use emoji, or if the text alone would genuinely be misread without one. At most one emoji per message. Never invent an emoji style that the profile does not describe.

HALLUCINATION GUARD
Only use details that are literally in the input message or conversation history. Words drawn from the operator's configured voice profile are register, not content claims, and do not need grounding. Specific facts about what the recipient is up to or how they feel must come from what they actually said. Do not invent shared experiences, jobs, places, or events.

RECIPROCITY RULE
Match the recipient's length and energy. A short message back gets a short reply. A multi-paragraph deep-share deserves real engagement. Do not over-deliver on a one-liner or under-deliver on a vulnerable share.

LATE-REPLY HINT
Casual platforms have softer norms than professional ones. Gaps under a week often do not need acknowledging at all. For longer gaps, a brief, natural, specific acknowledgement works. Avoid generic templated apologies.

OUTPUT
- No em dashes, en dashes, semicolons, or colons.
- Don't over-polish into something stiff, but don't fake typos either.
- Do not use marketing or hype phrases ("smashing it", "killing it", "crushing it").

Now generate the response in the operator's voice.`;

/**
 * Per-model request param shape. The GPT-5 family rotates which knobs are
 * accepted: gpt-5.4 supports `reasoning_effort: "none"` + `top_p`; gpt-5-nano
 * only accepts `minimal | low | medium | high` and rejects `top_p` entirely.
 * Centralise the picker here so a model swap doesn't require chasing every
 * call site.
 *
 * `verbosity: "medium"` and `reasoning_effort` are not (yet) typed in the
 * OpenAI SDK we ship — both are valid at the API layer but require a cast at
 * the call site to satisfy the typechecker.
 */
type Gpt5RequestOverrides = Record<string, unknown>;

function gpt5OptionsForModel(model: string): Gpt5RequestOverrides {
  // GLM family (Z.AI) — flash variants ignore most knobs and emit a separate
  // `reasoning_content` field automatically. Pass nothing extra; the OpenAI
  // SDK only reads `content` so the reasoning trace is harmlessly dropped.
  if (/^glm[-.]/i.test(model)) {
    return {};
  }
  // gpt-5-nano (and likely gpt-5-mini): minimal reasoning is the cheapest
  // setting. No top_p. verbosity is OK. Anything else gets the broader set.
  if (/^gpt-5-(nano|mini)/i.test(model)) {
    return {
      reasoning_effort: "minimal",
      verbosity: "medium"
    };
  }
  // gpt-5.4 family + base gpt-5: full knob set including no-reasoning.
  return {
    top_p: 0.98,
    reasoning_effort: "none",
    verbosity: "medium"
  };
}

/**
 * Provider-aware request param resolution. Replaces direct calls to
 * `gpt5OptionsForModel` so a non-OpenAI provider doesn't accidentally pick
 * up GPT-5 knobs. GLM and Gemini both reject GPT-5 params (verbosity,
 * reasoning_effort, top_p) at the wire — Google's OpenAI-compat endpoint
 * returns HTTP 400 for any of them.
 */
function providerOptions(provider: AiProvider, model: string): Gpt5RequestOverrides {
  if (provider === "glm" || provider === "gemini") return {};
  return gpt5OptionsForModel(model);
}

/**
 * Gemma 4 served through Google's OpenAI-compat endpoint emits unfiltered
 * <thought> reasoning traces by default — every JSON-mode call returns a
 * preamble that breaks zod parsing. The smoke test at
 * apps/runner/src/scripts/gemini-smoke.ts proved this is suppressible by
 * setting `thinking_level: "MINIMAL"` via Google's `extra_body` channel.
 * The narrow valid-value set is documented as MINIMAL / HIGH; LOW / MEDIUM
 * / numeric `thinking_budget` shapes get rejected with HTTP 400.
 *
 * No-op for every non-Gemma model. Gemini-2.x / 3.x flash served via the
 * compat endpoint don't need it (and rejecting silly extras is one way the
 * surface tells you that). OpenAI and GLM behaviour is unchanged.
 */
export function geminiExtraBody(provider: AiProvider, model: string): Record<string, unknown> {
  if (provider === "gemini" && /^gemma/i.test(model)) {
    return {
      extra_body: {
        google: {
          thinking_config: {
            thinking_level: "MINIMAL"
          }
        }
      }
    };
  }
  return {};
}

// ── Model-aware JSON-mode helpers ─────────────────────────────────────────
//
// Outcome D of the Gemini smoke test: Gemma 4 ships as default with the
// thinking_level=MINIMAL extra spread into every request via
// `geminiExtraBody`. With that flag in place, response_format is honoured
// and JSON parses cleanly. The reinforcement + fence-stripper below stay
// in as belt-and-braces for any future Gemma model rev that drifts.
//
// All four helpers (jsonReinforcementForModel, stripJsonFences,
// reinforceJsonPrompt, parseAiJson, shouldUseJsonResponseFormat) are
// model-aware so they are no-ops for non-Gemma models — OpenAI and GLM
// behaviour is unchanged.

function jsonReinforcementForModel(model: string): string {
  if (/^gemma/i.test(model)) {
    return "\n\nRespond ONLY with a single JSON object that matches the schema above. No markdown, no code fences, no commentary, no thinking traces.";
  }
  return "";
}

function stripJsonFences(content: string): string {
  return content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function reinforceJsonPrompt(prompt: string, model: string): string {
  return `${prompt}${jsonReinforcementForModel(model)}`;
}

function parseAiJson<T>(content: string, model: string): T {
  const cleaned = /^gemma/i.test(model) ? stripJsonFences(content) : content;
  return JSON.parse(cleaned) as T;
}

/**
 * Whether to send `response_format: { type: "json_object" }`. Outcome D
 * of the smoke test confirmed Gemma 4 honours response_format cleanly
 * once `thinking_level: "MINIMAL"` is set via `geminiExtraBody`, so we
 * keep it on for every supported provider/model combination.
 */
function shouldUseJsonResponseFormat(_provider: AiProvider, _model: string): boolean {
  return true;
}

// Strip the punctuation forms the system prompt forbids. Defensive — even
// with the rule in the system message, GPT-5 sometimes slips in an em-dash
// or a colon. Apply to every text-producing AI call before persisting /
// returning to the dashboard.
export function applyVoiceRules(text: string): string {
  if (!text) return text;
  return text
    .replace(/—/g, ", ")  // em-dash → comma to preserve flow
    .replace(/–/g, ", ")  // en-dash → comma
    .replace(/;/g, ".")   // semicolon → full stop
    .replace(/:/g, ",")   // colon → comma
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Enforce sentence-start capitalisation after . ? !. The voice prompts
// both ask for this but the model still slips ("hope you're good? things
// have been..." → should be "Things"). Belt-and-braces, applied to every
// text-producing AI call alongside applyVoiceRules.
//
// Rules:
//   - Looks for [.?!] followed by whitespace + a lowercase ASCII letter,
//     uppercases that letter. Standalone "?", "!" without trailing
//     whitespace are not sentence boundaries (they could be inside a
//     quoted phrase, emoji, or url) and are left alone.
//   - Lowercase "i" as a pronoun is uppercased to "I" when it lands at
//     sentence start — that's grammar, not voice. Mid-sentence "i" is
//     untouched.
//   - The very first character of the message is also capitalised, to
//     mirror the "capitals at message start" rule in both voice prompts.
//
// Examples:
//   "hope you're good? things have been..." → "hope you're good? Things have been..."
//   "Bet. Catch you later"                  → "Bet. Catch you later" (already capital, no-op)
//   "yhh i'm down, what time you thinking"  → "Yhh i'm down, what time you thinking"
//   "Damn fairs bro, you good? wanna talk"  → "Damn fairs bro, you good? Wanna talk"
export function enforceSentenceStartCapitals(text: string): string {
  if (!text) return text;
  let result = text.replace(/([.?!])(\s+)([a-z])/g, (_match, p1, p2, p3) => `${p1}${p2}${(p3 as string).toUpperCase()}`);
  // First-character capitalisation. Skip when the message starts with an
  // emoji / number / punctuation — only kicks in when the leading char is
  // a lowercase ASCII letter, which is the case we actually want to fix.
  if (/^[a-z]/.test(result)) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  return result;
}

// Soft trailing-period strip for short casual messages. The casual prompt
// says "Full stops basically absent" but the model still slips one in at
// the very end of a one-line reply. Only fires when the result is short
// and reads as a single thought — never strips when the message ends in
// "...", a question, an exclamation, an emoji, or contains multiple
// sentence-terminating marks (those carry meaning). Keeps the hard rules
// in applyVoiceRules pure and platform-agnostic.
//
// Examples:
//   "Hey, really appreciate that man." → "Hey, really appreciate that man"
//   "Yhh i'm down, what time you thinking." → "Yhh i'm down, what time you thinking"
//   "Bet." → "Bet"
//   "Hey. Hope you're good." → unchanged (two sentences, intentional shape)
//   "Sorry it's been a while. Things have been hectic, glad to hear from you" → unchanged
export function softenCasualTrailingPeriod(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed.endsWith(".") || trimmed.endsWith("...") || trimmed.endsWith("..")) return text;
  // Count sentence-final marks inside the body (excluding the trailing one
  // we're considering stripping). If there's already a "." mid-message,
  // this is a multi-sentence reply where the closing period is intentional.
  const body = trimmed.slice(0, -1);
  if (/[.!?]/.test(body)) return text;
  // Don't strip from longer prose — keep the rule scoped to one-line texts
  // and short two-clause replies, where casual messages typically don't
  // carry a trailing period.
  if (body.length > 140) return text;
  return text.replace(/\.\s*$/, "");
}

// Models occasionally narrate the prompt back to the operator ("the
// operator profile is not available, so no commonality can be identified").
// Strip any sentence that admits missing operator data — see issue #95.
export function stripOperatorMetaTalk(text: string): string {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    if (!lower.includes("operator")) return true;
    return !/(not available|unavailable|missing|unknown|no commonality|cannot be identified|can't be identified|isn't provided|is not provided|no operator profile)/.test(
      lower
    );
  });
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned.length > 0 ? cleaned : text;
}
const startersSchema = z.object({
  starters: z
    .array(
      z.object({
        angle: z.string().min(1),
        citedField: z.enum([
          "headline",
          "about",
          "experience",
          "education",
          "skills",
          "services",
          "recent_posts",
          "location"
        ]),
        text: z.string().min(1)
      })
    )
    .min(1)
    .max(4)
});

// One-line tone guidance per preferred reply style. Keeps the style
// picker in Settings meaningful to the model without a paragraph each.
const REPLY_STYLE_GUIDANCE: Record<string, string> = {
  warm: "lean friendly and personable, lead with warmth",
  direct: "be clear and to the point, no padding",
  casual: "keep it relaxed and informal, like texting a friend",
  thoughtful: "take care over the wording, considered and a little reflective",
  concise: "as short as it can be while still answering properly"
};

/**
 * Render the operator's configured voice + identity profile as a prompt
 * fragment. This is THE voice source — the FORMAL / CASUAL system prompts
 * are generic scaffolds, and this block tells the model who it is writing
 * as. Returns "" when the whole profile is blank, so an un-set-up user
 * gets the scaffold's plain neutral voice rather than an empty header.
 * Truncated per-field so a runaway paste in Settings can't blow the
 * context window.
 */
export function operatorProfileFragment(profile: OperatorProfile | null | undefined): string {
  const displayName = profile?.displayName?.trim();
  const about = profile?.about?.trim();
  const interests = profile?.interests?.trim();
  const commonPhrases = profile?.commonPhrases?.trim();
  const avoidedPhrases = profile?.avoidedPhrases?.trim();
  const style = profile?.preferredStyle?.trim();
  if (!displayName && !about && !interests && !commonPhrases && !avoidedPhrases && !style) {
    return "";
  }
  const lines: string[] = [
    "",
    "WRITE AS THIS PERSON (the operator's configured voice profile — use only the cues below, do not invent slang, emoji, or identity details that are not here):"
  ];
  if (displayName) lines.push(`- Their name: ${safeTruncate(displayName, 120)}`);
  if (about) lines.push(`- How they usually message people: ${safeTruncate(about, 800)}`);
  if (style) {
    const guidance = REPLY_STYLE_GUIDANCE[style];
    lines.push(`- Preferred reply tone: ${style}${guidance ? ` — ${guidance}` : ""}`);
  }
  if (commonPhrases) {
    lines.push(
      `- Words and phrases they use naturally (weave in only where they genuinely fit, never force): ${safeTruncate(commonPhrases, 600)}`
    );
  }
  if (avoidedPhrases) {
    lines.push(
      `- Words and phrases they never use (avoid these entirely): ${safeTruncate(avoidedPhrases, 600)}`
    );
  }
  if (interests) lines.push(`- Things they care about (keeps replies in-domain): ${safeTruncate(interests, 800)}`);
  return lines.join("\n");
}

/**
 * Stable fingerprint of an OperatorProfile for cache-key inclusion. The
 * suggested-replies cache is keyed on AI inputs so a Settings change
 * needs to invalidate cached replies — we feed this into the same
 * cacheKey hash. Trimmed so trailing whitespace edits don't churn the
 * cache. aiHelpLevel / setupCompletedAt are excluded: they don't change
 * the generated text, only whether the dashboard surfaces it.
 */
export function operatorProfileFingerprint(profile: OperatorProfile | null | undefined): string {
  if (!profile) return "";
  return [
    profile.displayName ?? "",
    profile.about ?? "",
    profile.interests ?? "",
    profile.commonPhrases ?? "",
    profile.avoidedPhrases ?? "",
    profile.preferredStyle ?? ""
  ]
    .map((value) => value.trim())
    .join("|");
}

/**
 * Stable fingerprint of a ContactProfileSnapshot for cache-key inclusion.
 * We deliberately key on the small subset of fields the prompt actually
 * reads, not the raw row, so a re-enrichment that produces identical
 * prompt-relevant content doesn't force a regeneration.
 */
export function contactSnapshotFingerprint(snap: ContactProfileSnapshot | null | undefined): string {
  if (!snap) return "";
  const recentPostFp = (snap.recentPosts ?? [])
    .slice(0, 5)
    .map((p) => `${p.postedAt ?? ""}::${(p.text ?? "").slice(0, 120)}`)
    .join("|");
  return [
    snap.headline ?? "",
    (snap.about ?? "").slice(0, 600),
    snap.location ?? "",
    snap.currentRole ?? "",
    snap.currentCompany ?? "",
    (snap.skills ?? []).slice(0, 10).join(","),
    recentPostFp
  ].join("§");
}

/**
 * Compress a ContactProfileSnapshot into the prompt-ready slice the AI
 * actually reads. Avoids dumping unbounded JSON into the model context —
 * each list is capped, each post body truncated. Numbers chosen to keep
 * the user message under ~3-4k tokens for the typical contact.
 */
function snapshotForPrompt(snap: ContactProfileSnapshot | null): Record<string, unknown> | null {
  if (!snap) return null;
  return {
    displayName: snap.displayName ?? null,
    headline: snap.headline ?? null,
    about: snap.about ? safeTruncate(snap.about, 600) : null,
    location: snap.location ?? null,
    currentRole: snap.currentRole ?? null,
    currentCompany: snap.currentCompany ?? null,
    experience: (snap.experience ?? []).slice(0, 5).map((e) => ({
      title: e.title ?? null,
      company: e.company ?? null,
      dates: e.dates ?? null,
      description: e.description ? safeTruncate(e.description, 240) : null
    })),
    education: (snap.education ?? []).slice(0, 4).map((e) => ({
      institution: e.institution ?? null,
      degree: e.degree ?? null,
      field: e.field ?? null,
      dates: e.dates ?? null
    })),
    skills: (snap.skills ?? []).slice(0, 10),
    services: (snap.services ?? []).slice(0, 6),
    recentPosts: (snap.recentPosts ?? []).slice(0, 5).map((p) => ({
      text: p.text ? safeTruncate(p.text, 280) : null,
      postedAt: p.postedAt ?? null,
      hasImage: Boolean(p.hasImage)
    }))
  };
}

export function createAiService(settingsStore: SettingsStore): AiService {
  // Build one client per provider up front, guarded by API key presence.
  // Z.AI and Google's Gemini API both expose OpenAI-compatible chat
  // endpoints, so reusing the OpenAI SDK with a different baseURL + key is
  // the whole integration. The provider choice is resolved per-call from
  // SettingsStore so a dashboard toggle takes effect without restarting
  // the runner.
  const openAiClient = runnerConfig.openAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.openAiApiKey })
    : null;
  const glmClient = runnerConfig.zAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.zAiApiKey, baseURL: runnerConfig.zAiBaseUrl })
    : null;
  const geminiClient = runnerConfig.geminiApiKey
    ? new OpenAI({ apiKey: runnerConfig.geminiApiKey, baseURL: runnerConfig.geminiBaseUrl })
    : null;

  // Per-provider client + model resolution. The set of clients is built
  // once at startup; any new provider added here also needs an entry in
  // `providerRegistry` (see ./ai-providers).
  function resolveProvider(providerId: AiProvider): { client: OpenAI | null; model: string } {
    if (providerId === "glm") {
      return { client: glmClient, model: runnerConfig.glmModel };
    }
    if (providerId === "gemini") {
      return { client: geminiClient, model: runnerConfig.geminiModel };
    }
    return { client: openAiClient, model: runnerConfig.openAiModel };
  }

  async function resolveActive(): Promise<{ client: OpenAI | null; model: string; provider: AiProvider }> {
    // Settings.aiProvider is the live override; runnerConfig.aiProvider is
    // the cold-start default seeded from the AI_PROVIDER env var. Settings
    // reads are a single SQLite row lookup — cheap enough to do per call.
    const settings = await settingsStore.getSettings();
    const providerId: AiProvider = settings.aiProvider ?? runnerConfig.aiProvider;
    if (providerId === "glm") {
      const model = settings.glmModel?.trim() || runnerConfig.glmModel;
      return { client: glmClient, model, provider: providerId };
    }
    if (providerId === "gemini") {
      const model = settings.geminiModel?.trim() || runnerConfig.geminiModel;
      return { client: geminiClient, model, provider: providerId };
    }
    return { client: openAiClient, model: runnerConfig.openAiModel, provider: providerId };
  }

  /**
   * One JSON-mode call against a specific provider, with bounded retries
   * for retriable error kinds (1302/1305 on GLM, 5xx on OpenAI). Returns
   * `ok: false` on any non-retriable failure or once attempts are
   * exhausted — the caller is expected to walk the fallback chain.
   */
  async function tryProvider<T>(
    providerId: AiProvider,
    model: string,
    prompt: string,
    parser: (value: unknown) => T,
    systemContent: string = SYSTEM_PROMPT
  ): Promise<{ ok: true; result: T } | { ok: false; classification: AiErrorClassification | null }> {
    const entry = providerRegistry[providerId];
    const { client } = resolveProvider(providerId);
    if (!client) {
      return { ok: false, classification: null };
    }

    let lastClass: AiErrorClassification | null = null;
    for (let attempt = 1; attempt <= entry.maxAttempts; attempt++) {
      try {
        const response = await client.chat.completions.create({
          model,
          ...(shouldUseJsonResponseFormat(providerId, model)
            ? { response_format: { type: "json_object" as const } }
            : {}),
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: reinforceJsonPrompt(prompt, model) }
          ],
          ...providerOptions(providerId, model),
          ...geminiExtraBody(providerId, model)
        });
        const content = response.choices[0]?.message?.content;
        if (!content) {
          lastClass = {
            kind: "empty_content",
            message: `${providerId} returned empty content (model=${model}, attempt ${attempt}/${entry.maxAttempts})`,
            retriable: true
          };
          console.warn(`[ai] ${lastClass.message}`);
          if (attempt < entry.maxAttempts) {
            await sleep(entry.baseBackoffMs * attempt + Math.random() * 1500);
            continue;
          }
          break;
        }
        return { ok: true, result: parser(parseAiJson(content, model)) };
      } catch (error) {
        lastClass = entry.classifyError(error);
        console.warn(
          `[ai] ${providerId} call failed (model=${model}, attempt ${attempt}/${entry.maxAttempts}). Reason: ${lastClass.message}`
        );
        if (lastClass.retriable && attempt < entry.maxAttempts) {
          await sleep(entry.baseBackoffMs * attempt + Math.random() * 1500);
          continue;
        }
        break;
      }
    }
    return { ok: false, classification: lastClass };
  }

  /**
   * JSON-mode call with retry + fallback chain.
   *
   * Walks the active provider first (with its `maxAttempts` retry budget),
   * then each entry in `fallbackChain` (skipping the active provider). The
   * returned `source` field tells the caller which provider actually
   * produced the result and, when fallback was used, why the active
   * provider was skipped — surfaced to the dashboard for suggested
   * replies so the operator knows their selection didn't run.
   */
  async function modelJson<T>(
    prompt: string,
    fallback: T,
    parser: (value: unknown) => T,
    systemContent?: string
  ): Promise<{ result: T; source: AiSource | null }> {
    const { provider: activeId, model: activeModel } = await resolveActive();
    const chain: AiProvider[] = [activeId, ...fallbackChain.filter((id) => id !== activeId)];

    let activeFailure: AiErrorClassification | null = null;

    for (let i = 0; i < chain.length; i++) {
      const providerId = chain[i]!;
      const isActive = i === 0;
      // Active provider honours the user's model override from settings;
      // fallback providers use the runtime config default.
      const model = isActive ? activeModel : resolveProvider(providerId).model;
      const outcome = await tryProvider(providerId, model, prompt, parser, systemContent);
      if (outcome.ok) {
        const entry = providerRegistry[providerId];
        const source: AiSource = {
          providerId,
          providerDisplayName: entry.displayName,
          fellBackFromProviderId: isActive ? null : activeId,
          fellBackFromProviderDisplayName: isActive ? null : providerRegistry[activeId].displayName,
          fellBackReason: isActive ? null : activeFailure?.kind ?? null,
          fellBackMessage: isActive ? null : activeFailure?.message ?? null
        };
        return { result: outcome.result, source };
      }
      if (isActive) {
        activeFailure = outcome.classification;
      }
    }

    // All providers exhausted — caller's fallback value is returned. Log
    // a single summary line so log-grepping for AI outages doesn't have
    // to walk the per-attempt lines and figure out the chain ended.
    console.warn(
      `[ai] all providers exhausted for active=${activeId}; returning caller fallback. ` +
        `Active provider's last failure: ${activeFailure?.message ?? "unknown"}`
    );
    const source: AiSource = {
      providerId: null,
      providerDisplayName: null,
      fellBackFromProviderId: activeId,
      fellBackFromProviderDisplayName: providerRegistry[activeId].displayName,
      fellBackReason: activeFailure?.kind ?? null,
      fellBackMessage: activeFailure?.message ?? null
    };
    return { result: fallback, source };
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function updateThreadSummary(input: {
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /**
     * True when the contact's last message is newer than the operator's —
     * i.e. an active ask is pending. False when the operator already
     * replied (or the thread is fresh), in which case the summary switches
     * to "reconnect mode": what_they_want and open_loops become hooks for
     * reopening the conversation rather than items to address.
     */
    needsReply: boolean;
  }): Promise<SummaryOutput> {
    const lastInbound = [...input.messages].reverse().find((msg) => msg.direction === "IN");
    const lastMessage = input.messages[input.messages.length - 1];

    const fallback: SummaryOutput = {
      summary: input.previousSummary ?? `Conversation with ${input.displayName}.`,
      // safeTruncate splits on Unicode code points so the cut won't bisect
      // an emoji's surrogate pair. Without it, a message ending in an
      // emoji at the boundary corrupts every subsequent prisma.thread
      // .update — see Sarah Nwisi sync-fail bug.
      // 120-char cap matches the Today hero headline's 4-line budget
      // (max-w-22ch, 36px display, ~31 chars/line). Staying within budget
      // means the operator reads the full fallback rather than an
      // ellipsis truncation (issue #193).
      what_they_want: lastInbound ? safeTruncate(lastInbound.text, 120) : "No clear ask yet.",
      open_loops: input.previousOpenLoops,
      tone_notes: [],
      needs_reply: lastMessage?.direction === "IN",
      urgency_hint: undefined
    };

    // Explicit schema in the prompt: gpt-5.4 honours response_format json_object
    // but interprets loose schemas creatively (returning {A,B,C} instead of
    // {replies:[{label,intent,text}]}). Spelling out the exact shape — keys,
    // types, and an example — keeps the zod parser at the call site happy.
    //
    // The `what_they_want` framing was originally "what the other person
    // is asking for" — that worked for outreach threads but produced an
    // empty-feeling field on peer threads where nobody is asking for
    // anything explicit. Reframed below as "what would help the operator
    // continue the relationship": acknowledge a thing they shared, follow
    // up on a hook, return warmth where warmth is offered. The label on
    // the dashboard ("What they want") stays the same so existing rows /
    // cache keys aren't disturbed; only the content shifts.
    // Render the message log with explicit speaker labels so the model
    // can never confuse who-said-what. `direction: "OUT"` = operator,
    // `direction: "IN"` = contact (the recipient). Reinforced in the
    // system prompt's ATTRIBUTION DISCIPLINE section.
    const transcript = input.messages
      .map((m) => {
        const speaker = m.direction === "OUT" ? "operator" : "contact";
        return `${speaker} (${m.timestamp}): ${m.text}`;
      })
      .join("\n");

    // The summary now operates in one of two modes, switched on
    // `needsReply`. Active-reply mode (contact's message is newest) asks
    // for a recap of the current exchange + loops adjacent to the active
    // topic. Reconnect mode (operator already replied or thread is
    // dormant) asks for warm callbacks the operator could use to reopen —
    // remembered details, things the contact said they'd do, hooks worth
    // bringing up. The data shape is identical so the dashboard renders
    // it the same way; only the content adapts.
    const modeBlock = input.needsReply
      ? `MODE: ACTIVE REPLY. The contact is waiting on the operator.

what_they_want guidance (active reply):
- 1-2 short sentences, STRICTLY 120 CHARACTERS OR FEWER, plain prose, British English, no trailing ellipsis.
- Recap what the last 2-3 messages have actually said — name the topic and what the contact is waiting on the operator to do or answer next.
- Ground in real content from the recent messages. Do not paraphrase into vague abstractions ("a quick coordination on location") when the messages have specifics ("asked if you've watched the MJ movie; he's deciding whether to go with Timi"). If you can't ground it in named content, fall back to literally quoting the gist.
- Examples: "Sultan asked if you've watched the MJ movie — he's deciding whether to go with Timi.", "Carlos confirmed Friday lunch — he's waiting on you to pick a time.", "She shared photos from Lagos and asked when you're free for dinner."

open_loops guidance (active reply):
- Focus on items adjacent to the CURRENT active topic. The most recent 2-3 inbound messages define what's live.
- DROP any older loops where the conversation has clearly moved on to an unrelated topic. If the recent exchange is about a movie and the old loops are about a months-old logistics request, do not surface those — they're stale.
- EXCLUDE any loop where the operator (or the contact themselves) already answered or substantively addressed it later in the same transcript.
- A loop is still open if it was acknowledged ("yeah good question") but never actually answered.
- 0-4 loops is fine. Quality over volume. The bar is "would the operator genuinely want to pick this up right now, given what's being discussed".
- Phrase each as a short follow-up prompt: "Send the doc they asked about" / "Pick up the thread about their move to Lagos".`
      : `MODE: RECONNECT. The operator has the floor — the contact is not currently waiting on anything specific. The summary's job here is to help the operator reopen the conversation warmly, not to surface tasks.

what_they_want guidance (reconnect):
- 1-2 short sentences, STRICTLY 120 CHARACTERS OR FEWER, plain prose, British English, no trailing ellipsis.
- Frame as: "what's the warmest, most natural way for the operator to reopen this thread, grounded in something specific the contact has shared." Reference a real detail from the transcript — something they mentioned doing, a thing they were working through, a small life update.
- Do NOT phrase as a task the operator owes. This is reconnect mode — the operator is choosing to reach out, not responding to a pending ask.
- Examples: "Sultan mentioned exam stress last month — a 'how'd they go?' check-in is natural.", "She was deciding between two job offers — worth asking how that landed.", "He said he'd send the doc but went quiet; a light nudge would land well."

open_loops guidance (reconnect):
- These become "warm callbacks" — small specific things from the transcript that would feel good to bring up. Things the contact shared, mentioned, or said they'd do. Things the operator could genuinely remember and ask about.
- Lean on specificity. "Ask how the new role is going" beats "Catch up on work". "Follow up on whether they found Tolu" beats "Check in on logistics".
- DROP anything where bringing it up would feel like dredging up an awkward stale request. If the transcript moved past a topic months ago, leave it.
- 0-5 callbacks is fine.
- Phrase each as a short prompt the operator could act on: "Ask how the move to Lagos went" / "Mention you finally watched the MJ doc" / "Check in on the new role".`;

    const prompt = `Return strict JSON matching this exact shape:
{
  "summary": "string — 1-2 sentence rolling summary of the relationship (durable across turns)",
  "what_they_want": "string — see mode-specific guidance below",
  "open_loops": ["string", ...],
  "tone_notes": ["string", ...],
  "needs_reply": true | false,
  "urgency_hint": "string or omit if none"
}

Reminder: lines starting with \`operator:\` are the operator's own words; lines starting with \`contact:\` are the other person. Never paraphrase one as if it were the other.

${modeBlock}

General rules (both modes):
- One loop per item. Don't merge ("their work + their move + their dog") into a single string.
- Phrase loops as actions the operator can take, never as the contact's quoted question.
- The "summary" field stays stable — it's the durable relationship description, not the mode-specific recap. Update it only when the relationship itself shifts (new shared context, role change, etc.).

Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Transcript:
${transcript}`;

    const { result } = await modelJson(prompt, fallback, (value) => summarySchema.parse(value));
    // Hard cap. The prompt asks for ≤ 120 chars but the model occasionally
    // returns longer prose; this keeps the Today hero headline within its
    // 4-line budget. safeTruncate trims at the code-point boundary and
    // does not append an ellipsis (issue #193).
    if (result.what_they_want.length > 120) {
      result.what_they_want = safeTruncate(result.what_they_want, 120);
    }
    return result;
  }

  async function generateSuggestedReplies(input: {
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    /**
     * Last 6 turns of the transcript (oldest first). Replaces the previous
     * single-string `lastInboundMessage`: the model needs the back-and-
     * forth to spot when the operator has already engaged on the topic
     * (e.g. operator said "yhh why?" then the contact clarified — the
     * reply must respond to the clarification, not treat it as a cold
     * ask). Each entry includes the speaker direction.
     */
    recentMessages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /**
     * True when the contact's last message is newer than the operator's.
     * When false, the prompt switches to "reopen mode": generates three
     * conversation starters grounded in transcript details rather than
     * direct replies to a pending message.
     */
    needsReply: boolean;
    /**
     * Drives the voice tier (LinkedIn → formal; everything else → casual)
     * so the suggested replies sit in the right register. Optional for
     * backwards compatibility with older callers; when omitted, the
     * generic SYSTEM_PROMPT is used and no voice-tier prompt is added.
     */
    platform?: PlatformName | null;
    /**
     * Recent outbound messages on THIS thread, oldest first. Calibrates
     * register and warmth to how the operator actually talks to this
     * specific contact (formal with mentors, banter with mates). Empty
     * is fine — the few-shot examples in the voice prompt are the
     * primary reference.
     */
    voiceSamples?: string[];
    /**
     * Recent inbound messages on THIS thread, oldest first (excluding
     * the very latest, which is passed as lastInboundMessage). Shows the
     * model the recipient's voice across the conversation so the reply
     * can match their tempo rather than reacting only to the last line.
     */
    recipientSamples?: string[];
    /**
     * Thread classification. When "outreach", the third reply slot is a
     * "Polite decline" instead of a "Clarifying question" — short friendly
     * "not interested" wording per the operator's voice rules.
     */
    category?: "outreach" | "genuine" | null;
    /**
     * ISO timestamp of the most recent inbound message. When present and
     * the gap to "now" is large, the prompt gets an instruction to open
     * with a brief acknowledgement of the gap — the elephant-in-the-room
     * problem when replying to a thread weeks/months late.
     */
    lastInboundAt?: string | null;
    /**
     * ISO timestamp of the most recent outbound message. Used alongside
     * lastInboundAt to decide whether the gap is the operator's silence
     * (we should acknowledge) or just an old thread already closed
     * (don't apologise unprompted).
     */
    lastOutboundAt?: string | null;
    operatorProfile?: OperatorProfile | null;
    contact?: ContactProfileSnapshot | null;
  }): Promise<SuggestedRepliesOutput> {
    const isOutreach = input.category === "outreach";

    // Late-reply detection: only acknowledge a gap when the inbound is
    // more recent than the outbound (otherwise the operator already
    // replied and we'd apologise for nothing) and the gap is ≥ 14 days.
    // Mid-range bucket (14-30d) gets a softer phrasing than long range
    // (30d+) which is more direct about the silence.
    const lateReplyHint = (() => {
      if (!input.lastInboundAt) return "";
      const inboundMs = Date.parse(input.lastInboundAt);
      if (!Number.isFinite(inboundMs)) return "";
      const outboundMs = input.lastOutboundAt ? Date.parse(input.lastOutboundAt) : NaN;
      // Only acknowledge if WE haven't already replied since their last
      // message. If outboundMs > inboundMs the operator's already on top.
      if (Number.isFinite(outboundMs) && outboundMs >= inboundMs) return "";
      const gapDays = (Date.now() - inboundMs) / (1000 * 60 * 60 * 24);
      if (gapDays < 14) return "";
      const phrase =
        gapDays >= 60
          ? "It's been a long time (months). Open every reply with a brief, natural apology for the silence (e.g. 'Sorry it's been ages — life got in the way') before getting to the substance."
          : gapDays >= 30
            ? "It's been over a month. Open every reply with a brief, natural acknowledgement of the gap (e.g. 'Sorry I'm only just getting back to this') before the substance."
            : "It's been a couple of weeks since they wrote. Add a light acknowledgement of the gap to reply A (e.g. 'Sorry for the slow reply') — replies B and C can omit it.";
      return `\nLate-reply context: ${phrase}\n`;
    })();
    // Empty fallback — when the model fails (timeout, empty content, parse
    // error) we surface that to the dashboard via `needs_user_input` instead
    // of inventing canned replies. Generic "Thanks for the note. To be
    // honest, that works for us."-style placeholders look like AI output
    // but aren't, which leads to operators sending nonsense in the worst
    // case. Empty replies + a plain explanation is the honest signal.
    const fallback: SuggestedRepliesOutput = {
      replies: [],
      needs_user_input: [
        "Couldn't generate suggestions for this thread — write your reply or click rescan to try again."
      ]
    };

    // Render the recent exchange so the model can see who said what.
    // Previous prompt only passed `lastInboundMessage` as a string, which
    // hid the operator's own most recent turn — if the operator had
    // already engaged with a short reply, the model would still generate
    // replies as if responding to a cold ask. Now it sees the back-and-
    // forth and can produce a reply that fits the actual conversational
    // turn. The operator's own entries here also serve as per-thread
    // voice calibration — register, vocabulary, length, punctuation
    // habits to mirror.
    const recentExchange = input.recentMessages
      .map((m) => {
        const speaker = m.direction === "OUT" ? "operator" : "contact";
        return `${speaker}: ${m.text}`;
      })
      .join("\n");

    // Mode switches the whole framing. In reply mode the model produces
    // three responses to the contact's pending message. In reopen mode
    // the operator chose to reach out into a quiet thread, so the model
    // produces three conversation starters grounded in concrete details
    // from the transcript (warm callbacks, "wow you remembered" moments,
    // small things the contact mentioned that would feel good to bring
    // up). The output shape is identical so the dashboard renders both
    // the same way.
    const modeBlock = input.needsReply
      ? `MODE: REPLY. The contact's last message is waiting on a response.

What to generate: three sendable replies to the most recent contact message, accounting for the full recent exchange above. If the operator already responded to part of the topic earlier in this exchange, the replies must build on that — do NOT treat the contact's last message as a cold ask when the operator has already engaged.

INTENT LABELS — pick three intents that genuinely fit THIS conversation.
Each intent is a 2-4 word noun phrase describing the angle of that reply.
The three intents must be meaningfully different from each other and must
be CHOSEN FROM THE THREAD CONTENT, not from any default list.

Hard rules:
- Never use the literal phrases "Direct + helpful",
  "Warm + relationship-first", or "Clarifying question". They are banned —
  pick wording that describes what THIS reply is doing in THIS thread.
- For a brief greeting only ("hi", "hello", "👋", "good morning"), do NOT
  include a clarifying-question slot. The three replies should be three
  ways to warmly continue the conversation (e.g. mirror, open a topic,
  share something brief). A greeting needs no clarification.
- When the inbound is short and ambiguous about substance, only include a
  question slot if the question is genuinely useful to the operator's
  next move. Otherwise pick three different forward-moving angles.
- Each intent describes WHAT THIS REPLY DOES, in this thread's context —
  e.g. "Acknowledge their move", "Suggest a time", "Match their warmth",
  "Offer a small update", "Decline gently", "Ask about timeline". Make
  them specific to what was actually said.${
    isOutreach
      ? `\n- This thread is OUTREACH (sales pitch, recruitment, InMail, cold solicitation). Reply C MUST be a friendly Polite decline (~1 sentence, no commitment, no follow-up question), labelled with intent "Polite decline". Replies A and B can still pick intents that fit.`
      : ""
  }`
      : `MODE: REOPEN. The operator is reaching back into a thread where nothing is currently pending — there's no message waiting on a reply. Generate three conversation starters the operator could send right now to reopen warmly.

What to generate: three OPENERS the operator could send into this quiet thread. Each one must:
- Reference something SPECIFIC from the transcript above (a thing the contact mentioned, shared, said they'd do, was working through, complained about, was excited by). Cite the concrete detail — "the move to Lagos", "the new role", "exam stress", "the doc you owed them" — not a generic "catch up".
- Land as a "wow, you remembered" moment if possible. Small specific recall beats grand re-greetings.
- Be sendable as a first message into a quiet thread — no "in reply to your last…" framing.
- Sit in the operator's voice.

Hard rules:
- The three openers must reference three DIFFERENT details. Don't generate three variations on the same callback.
- Do NOT invent details that aren't in the transcript. If you can't ground a third opener in a real detail, return only two replies and put a note in needs_user_input.
- No generic "hey how have you been" filler unless there's literally nothing else in the transcript. In that case one slot can be a warm "hey how are things" but the other two must still ground in something real.
- Each intent describes the callback: "Ask about the Lagos move", "Follow up on exam stress", "Mention you watched the doc". Avoid "Clarifying question" — there's nothing to clarify in reopen mode.`;

    const prompt = `Return strict JSON matching this exact shape:
{
  "replies": [
    { "label": "A", "intent": "<short noun phrase>", "text": "..." },
    { "label": "B", "intent": "<short noun phrase>", "text": "..." },
    { "label": "C", "intent": "<short noun phrase>", "text": "..." }
  ],
  "needs_user_input": ["string", ...]
}

Each reply text must be a complete, sendable message under 280 characters,
1-2 sentences, British English. No em dashes, en dashes, semicolons, or
colons. Match the conversation's register: warm if it's warm, formal if
it's formal.

${modeBlock}${lateReplyHint}${operatorProfileFragment(input.operatorProfile)}${
  input.contact
    ? `\n\nContact profile (use to ground references in something the contact has actually said or shared, do NOT invent details that are not present):\n${JSON.stringify(snapshotForPrompt(input.contact))}`
    : ""
}

Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Recent exchange (oldest first):
${recentExchange || "(no recent messages)"}`;

    // Voice-tier system prompt — was missing here previously, so suggested
    // replies ran on the generic SYSTEM_PROMPT only and read flatter than
    // composeInVoice output. When platform is set, layer the appropriate
    // voice scaffold on top so register matches the channel (LinkedIn
    // formal / professional; WhatsApp / iMessage / IG / TikTok casual).
    const systemContent = input.platform
      ? `${SYSTEM_PROMPT}\n\n${selectVoicePrompt(input.platform)}`
      : SYSTEM_PROMPT;
    const tier = input.platform ? getVoiceTier(input.platform) : null;

    const { result: parsed, source } = await modelJson(
      prompt,
      fallback,
      (value) => repliesSchema.parse(value),
      systemContent
    );
    // Defensive scrub of em-dashes, semicolons, colons — see applyVoiceRules.
    // For casual platforms, also strip trailing periods on short replies
    // since casual texts typically don't carry them.
    return {
      ...parsed,
      replies: parsed.replies.map((r) => {
        let cleaned = applyVoiceRules(r.text);
        cleaned = enforceSentenceStartCapitals(cleaned);
        return {
          ...r,
          text: tier === "casual" ? softenCasualTrailingPeriod(cleaned) : cleaned
        };
      }),
      source
    };
  }

  async function transformReply(input: { mode: "SHORTEN" | "MAKE_WARMER"; text: string }): Promise<string> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return input.text;
    }

    try {
      const instruction =
        input.mode === "SHORTEN"
          ? "Shorten this message to <= 160 characters while preserving intent."
          : "Make this message warmer while preserving intent and keeping it concise.";

      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${instruction}\n\n${input.text}` }
        ],
        // No response_format: this returns plain text. The voice-rule
        // post-processor handles em-dash / semicolon / colon scrubbing.
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });

      const raw = response.choices[0]?.message?.content?.trim() || input.text;
      return enforceSentenceStartCapitals(applyVoiceRules(raw));
    } catch (error) {
      console.warn(
        `[ai] transformReply failed (provider=${provider}, model=${model}, mode=${input.mode}); returning original text. ${classifyLlmError(error, provider)}`
      );
      return input.text;
    }
  }

  /**
   * Classify a thread as outreach (sales / recruitment / marketing / InMail
   * / cold solicitation) vs genuine (peer chats, ongoing relationships).
   * Returns null when the AI service is unavailable — callers should treat
   * that as "leave the column unset", not as a default verdict.
   *
   * Earlier version only saw the first 1-2 inbound messages, which missed
   * the common pivot pattern: a friendly opener ("just seen what you're
   * building, how's it going?") followed two messages later by a sales
   * question ("are you already working with an accountant?"). Now we feed:
   *   - the rolling AI summary (high signal — already captures intent)
   *   - the whatTheyWant extraction
   *   - up to 5 inbound messages (the full early arc, not just the opener)
   *
   * Trade-off: ~3x token usage per classification (~200 vs ~70). Still cheap
   * on gpt-5-nano (sub-cent per thread). Catches the Kyle Randall case
   * where the second-half pivot was the giveaway.
   */
  async function classifyThreadCategory(input: {
    /** Drives prompt tier (LinkedIn → formal LinkedIn-shaped categories;
     * everything else → casual messaging-app outreach patterns). */
    platform: PlatformName;
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    summary?: string | null;
    whatTheyWant?: string | null;
  }): Promise<"outreach" | "genuine" | null> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }

    const inboundMessages = input.messages
      .filter((m) => m.direction === "IN")
      .slice(0, 5)
      .map((m) => safeTruncate(m.text, 600))
      .filter((t) => t.trim().length > 0);

    if (inboundMessages.length === 0) {
      return null;
    }

    const summaryLine = input.summary?.trim()
      ? `Summary so far: ${safeTruncate(input.summary, 600)}`
      : "Summary so far: (none)";
    const whatTheyWantLine = input.whatTheyWant?.trim()
      ? `What they want: ${safeTruncate(input.whatTheyWant, 400)}`
      : "What they want: (none)";

    const prompt = `${selectClassifyPromptPrefix(input.platform)}

Person name: ${input.displayName}
${summaryLine}
${whatTheyWantLine}
Inbound messages (oldest first):
${inboundMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = categorySchema.parse(parseAiJson(content, model));
      return parsed.category;
    } catch (error) {
      console.warn(
        `[ai] classifyThreadCategory failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  /**
   * Generate a 2-3 sentence summary of who this contact is, drawing on
   * their LinkedIn profile and any commonality with the operator. Voice
   * rules apply — punctuation post-processor scrubs em-dashes etc. as
   * usual. Returns null when the AI client isn't configured so the
   * dashboard can hide the section instead of showing a placeholder.
   */
  async function generateContactSummary(input: {
    contact: ContactProfileSnapshot;
    self: ContactProfileSnapshot | null;
  }): Promise<string | null> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }

    const contactPayload = snapshotForPrompt(input.contact);
    const selfPayload = snapshotForPrompt(input.self);
    const hasOperatorProfile = selfPayload !== null;
    const operatorBlock = hasOperatorProfile
      ? `\nOperator profile: ${JSON.stringify(selfPayload)}`
      : "";
    const commonalityRule = hasOperatorProfile
      ? "Lead with their current role or focus, then any clear commonality with the operator (shared school, shared work area, shared interest)."
      : "Lead with their current role or focus and add one or two grounded details from the contact's profile (location, recent post, area of work). Do not mention the operator at all. Never write that anything is unavailable, missing, unknown, or cannot be identified.";
    const prompt = `Summarise who this contact is in 2 to 3 sentences for the operator.
${commonalityRule}

Style:
- British English. Conversational, like a peer briefing a peer.
- No em dashes, en dashes, semicolons, or colons.
- Plain prose. No headings, bullet points, or labels.
- Stick to facts that are present in the data. Do not invent details.

Return strict JSON: { "summary": "string" }

Contact profile: ${JSON.stringify(contactPayload)}${operatorBlock}`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = z.object({ summary: z.string().min(1) }).parse(parseAiJson(content, model));
      return stripOperatorMetaTalk(applyVoiceRules(stripUnpairedSurrogates(parsed.summary)));
    } catch (error) {
      console.warn(
        `[ai] generateContactSummary failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  /**
   * Generate 2-3 conversation openers grounded in the contact's profile.
   * Each opener cites which enrichment field its commonality came from
   * (`citedField`); the orchestration layer then verifies the field is
   * actually populated in the contact's data, dropping any opener whose
   * citation doesn't resolve. This catches the model claiming to have
   * used field X while inventing the content. Returns null when the AI
   * client isn't configured.
   */
  async function generateConversationStarters(input: {
    /** Cold-opener generation is LinkedIn-only — the prompt and the
     * underlying ContactProfileSnapshot fields (headline, experience,
     * education, recent_posts) are LinkedIn-shaped, and PersonEnrichment
     * rows only get populated for LinkedIn people anyway. Casual platforms
     * return null so the People page hides the section instead of showing
     * starters that don't fit the register. */
    platform: PlatformName;
    contact: ContactProfileSnapshot;
    self: ContactProfileSnapshot | null;
  }): Promise<ConversationStartersOutput | null> {
    if (getVoiceTier(input.platform) !== "formal") {
      return null;
    }
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }

    const contactPayload = snapshotForPrompt(input.contact);
    const selfPayload = snapshotForPrompt(input.self);
    const prompt = `Draft 2 to 3 conversation openers the operator could send to start a fresh chat with this contact on LinkedIn.

Each opener must reference a real commonality between the operator and the contact (shared school, shared field of work, complementary roles, a recent post the contact made, a shared location). Do not invent details that are not in the provided data. If the operator's profile is null, ground the opener in something specific from the contact alone (a recent post, their headline, their location).

For each opener, set "citedField" to the single enrichment field whose content the opener leans on. Allowed values: "headline", "about", "experience", "education", "skills", "services", "recent_posts", "location". If the opener references a recent post, use "recent_posts". If it references the contact's role, use "experience" or "headline". Pick the most direct source.

Style:
- British English. Conversational, warm, peer-to-peer. No corporate filler.
- Each opener up to 500 characters, 1 to 3 sentences.
- No em dashes, en dashes, semicolons, or colons.
- End with a soft, optional invitation, not a hard ask.

Return strict JSON: { "starters": [ { "angle": "string", "citedField": "headline" | "about" | "experience" | "education" | "skills" | "services" | "recent_posts" | "location", "text": "string" }, ... ] }

Contact profile: ${JSON.stringify(contactPayload)}
Operator profile: ${JSON.stringify(selfPayload)}`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = startersSchema.parse(parseAiJson(content, model));
      return {
        starters: parsed.starters.map((s) => ({
          angle: applyVoiceRules(s.angle),
          citedField: s.citedField as ConversationStarterCitedField,
          text: applyVoiceRules(stripUnpairedSurrogates(s.text))
        }))
      };
    } catch (error) {
      console.warn(
        `[ai] generateConversationStarters failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  /**
   * "Tell me what you want to say, I'll write it the way you'd write it."
   * The operator types a brief intent ("ask if they're free next week",
   * "decline politely", "follow up on the data project") and gets back
   * a sendable draft calibrated to their own voice on this specific
   * thread. The voice samples are recent OUTBOUND messages from the
   * thread — calibrating against the relationship rather than against
   * an aggregate self-profile keeps register and warmth right (formal
   * with formal contacts, warm with friends).
   *
   * Fallback returns the intent verbatim — the composer never goes
   * empty even when the AI service is unavailable.
   */
  async function composeInVoice(input: {
    intent: string;
    platform: PlatformName;
    displayName: string;
    voiceSamples: string[];
    threadMessages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    relationshipContext?: {
      otherThreadCount: number;
      recentExchanges: Array<{
        platform: string;
        lastMessageAt: string | null;
        preview: string | null;
        whatTheyWant: string | null;
      }>;
      notes: string | null;
      tags: string[];
    };
    operatorProfile?: OperatorProfile | null;
    contact?: ContactProfileSnapshot | null;
  }): Promise<string> {
    const trimmed = input.intent.trim();
    if (!trimmed) return "";
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return trimmed;
    }

    const cleanedSamples = input.voiceSamples
      .map((sample) => sample.trim())
      .filter((sample) => sample.length > 0)
      .slice(-6); // Last 6 outbound messages — enough to learn voice without bloating the prompt.

    // Recipient's recent messages, oldest first, capped at 4. Shows the
    // model the conversation rhythm from THEIR side — how long their
    // messages run, how they punctuate, what register they sit in. Lets
    // the rewrite match their tempo rather than only the last line.
    const recipientSamples = input.threadMessages
      .filter((m) => m.direction === "IN")
      .map((m) => m.text.trim())
      .filter((t) => t.length > 0)
      .slice(-4);

    const lastInbound = [...input.threadMessages].reverse().find((m) => m.direction === "IN");
    const lastOutbound = [...input.threadMessages].reverse().find((m) => m.direction === "OUT");
    // Acknowledge a long gap if the operator is replying weeks/months
    // after the other party's last message. Threshold matches the
    // suggested-replies prompt below for consistency.
    const lastInboundAt = lastInbound ? Date.parse(lastInbound.timestamp) : NaN;
    const lastOutboundAt = lastOutbound ? Date.parse(lastOutbound.timestamp) : NaN;
    const gapDays = (() => {
      if (!Number.isFinite(lastInboundAt)) return 0;
      const ref = Number.isFinite(lastOutboundAt) ? Math.max(lastInboundAt, lastOutboundAt) : lastInboundAt;
      // Gap = how long since the most recent message in the thread.
      return Math.max(0, (Date.now() - ref) / (1000 * 60 * 60 * 24));
    })();

    // Late-reply hint, bucketed so the opener varies by gap length rather
    // than every output starting "Sorry it's been ages". The phrasing is a
    // suggestion, not a literal template — the model picks a fit in voice.
    const lateReplyHint = (() => {
      if (
        gapDays < 14 ||
        !lastInbound ||
        (lastOutbound && lastInbound.timestamp < lastOutbound.timestamp)
      ) {
        return "";
      }
      const days = Math.round(gapDays);
      let suggestions: string;
      if (gapDays >= 60) {
        suggestions = `e.g. "Hey long time man", "Sorry it's been ages"`;
      } else if (gapDays >= 30) {
        suggestions = `e.g. "Sorry for the slow reply", "Sorry it's taken me a min"`;
      } else {
        suggestions = `e.g. "Sorry for the late reply", "sorry only just seeing this"`;
      }
      return `\nThe operator hasn't replied in ${days} days. Open with a brief, natural acknowledgement of the gap in his register (${suggestions}) — pick whichever fits, don't dwell on it, name it once and move on.`;
    })();

    // Cross-thread relationship hint. Pulled from the dashboard's
    // /data/thread relationshipMemory; gives the model just enough
    // history to avoid repeating questions or contradicting prior tone.
    // Capped to ~3 exchanges so prompt size stays bounded.
    const relationshipHint = (() => {
      const ctx = input.relationshipContext;
      if (!ctx || ctx.otherThreadCount === 0) return "";
      const exchanges = ctx.recentExchanges.slice(0, 3).map((ex, i) => {
        const ts = ex.lastMessageAt ? ` (${new Date(ex.lastMessageAt).toISOString().slice(0, 10)})` : "";
        return `${i + 1}. [${ex.platform}${ts}] ${safeTruncate(ex.preview ?? ex.whatTheyWant ?? "(no preview)", 220)}`;
      });
      const tagsLine = ctx.tags.length > 0 ? `\nTags: ${ctx.tags.join(", ")}` : "";
      const notesLine = ctx.notes ? `\nNotes: ${safeTruncate(ctx.notes, 240)}` : "";
      return `\n\nRelationship context (other threads with this person, do NOT repeat questions already answered elsewhere):${tagsLine}${notesLine}\n${exchanges.join("\n")}`;
    })();

    const prompt = `Rewrite the operator's intent below as a complete, sendable ${platformMessageNoun(input.platform)} in the operator's voice. Match the length and energy of the recipient's last message (reciprocity rule from system prompt). When in doubt, err shorter. The voice samples below are additional calibration for this thread, the few-shot examples in the system prompt are the primary reference.

Operator's intent: ${safeTruncate(trimmed, 600)}

Recipient: ${input.displayName}

Recent voice samples (operator's own past messages on this thread, oldest first):
${cleanedSamples.length > 0 ? cleanedSamples.map((s, i) => `${i + 1}. ${safeTruncate(s, 320)}`).join("\n") : "(no prior outbound on this thread — match general British peer-to-peer warmth)"}
${recipientSamples.length > 0 ? `\nRecipient's recent messages on this thread (oldest first — match their tempo, length, and warmth, not just the last line):\n${recipientSamples.map((s, i) => `${i + 1}. ${safeTruncate(s, 320)}`).join("\n")}` : ""}
${lastInbound ? `\nLast message from recipient: ${safeTruncate(lastInbound.text, 400)}` : ""}${lateReplyHint}${relationshipHint}${operatorProfileFragment(input.operatorProfile)}${
  input.contact
    ? `\n\nRecipient profile (ground references in real fields here, do not invent):\n${JSON.stringify(snapshotForPrompt(input.contact))}`
    : ""
}

Return strict JSON: { "text": "string" }`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: selectVoicePrompt(input.platform) },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return trimmed;
      const parsed = z.object({ text: z.string().min(1) }).parse(parseAiJson(content, model));
      let cleaned = applyVoiceRules(stripUnpairedSurrogates(parsed.text));
      cleaned = enforceSentenceStartCapitals(cleaned);
      return getVoiceTier(input.platform) === "casual" ? softenCasualTrailingPeriod(cleaned) : cleaned;
    } catch (error) {
      console.warn(
        `[ai] composeInVoice failed (provider=${provider}, model=${model}); returning raw intent. ${classifyLlmError(error, provider)}`
      );
      return trimmed;
    }
  }

  /**
   * Pull explicit time hints out of the latest inbound message and turn
   * them into 1-3 snooze targets ({label, hours, reason}). When no hint
   * is present, returns an empty list — never invents a target. This is
   * the engine behind the snooze chips on the thread page.
   */
  async function suggestSnoozeTimings(input: {
    displayName: string;
    lastInboundText: string;
    lastInboundAt: string | null;
    summary?: string | null;
    whatTheyWant?: string | null;
  }): Promise<{ suggestions: Array<{ label: string; hours: number; reason: string }> }> {
    const inbound = input.lastInboundText.trim();
    if (!inbound) return { suggestions: [] };
    const { client, model, provider } = await resolveActive();
    if (!client) return { suggestions: [] };

    const referenceIso = input.lastInboundAt ?? new Date().toISOString();
    const prompt = `You are a calendar assistant. Read the last message from a contact and decide whether the operator should snooze the conversation. ONLY suggest a snooze when the message contains an explicit time hint ("let's chat next Tuesday", "I'm OOO until the 15th", "ping me Friday morning"). When there is no clear time hint, return an empty list. Do not invent.

Reference time (the message arrived at): ${referenceIso}
Recipient: ${input.displayName}
Thread summary: ${safeTruncate(input.summary ?? "", 200)}
What they want: ${safeTruncate(input.whatTheyWant ?? "", 160)}

Last inbound message:
${safeTruncate(inbound, 600)}

Pick at most 3 snooze targets. Each target is:
- label: short chip text (e.g. "Tue 9am", "Mon morning", "Next Friday")
- hours: integer hours to snooze, between 1 and 72 (max 3 days, matches the snooze route limit)
- reason: 1 short sentence quoting the trigger phrase from the message

Return strict JSON: { "suggestions": [{ "label": "string", "hours": 1-168, "reason": "string" }] }
If the message has no time hint, return { "suggestions": [] }.`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return { suggestions: [] };
      const parsed = z
        .object({
          suggestions: z
            .array(
              z.object({
                label: z.string().min(1).max(40),
                hours: z.number().int().min(1).max(72),
                reason: z.string().min(1).max(220)
              })
            )
            .max(3)
        })
        .parse(parseAiJson(content, model));
      return parsed;
    } catch (error) {
      console.warn(
        `[ai] suggestSnoozeTimings failed (provider=${provider}, model=${model}); returning empty list. ${classifyLlmError(error, provider)}`
      );
      return { suggestions: [] };
    }
  }

  /**
   * Per-person friendship summary for iMessage contacts. Operates on the
   * union of messages across every thread the operator has with this
   * person. Produces four sections per Q9 of v0.3.0:
   *   - how_you_know_each_other (from earliest messages, 1-2 sentences)
   *   - recent_topics (last 30 days, bullet list)
   *   - inside_jokes (recurring references / running threads)
   *   - vibe (tone summary of the relationship)
   *
   * Empty / very short transcripts collapse gracefully: the model is told
   * to return short honest answers ("not enough history yet") rather than
   * fabricating context. The attribution-discipline reminder applies the
   * same way it does in updateThreadSummary - operator: vs contact: in
   * the rendered transcript.
   */
  async function summarisePersonForFriendship(input: {
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
  }): Promise<FriendshipSummaryOutput> {
    const fallback: FriendshipSummaryOutput = {
      how_you_know_each_other: "Not enough message history yet to summarise.",
      recent_topics: [],
      inside_jokes: [],
      vibe: "Not enough message history yet to characterise."
    };

    if (input.messages.length === 0) {
      return fallback;
    }

    const transcript = input.messages
      .map((m) => {
        const speaker = m.direction === "OUT" ? "operator" : "contact";
        return `${speaker} (${m.timestamp}): ${m.text}`;
      })
      .join("\n");

    const prompt = `Return strict JSON matching this exact shape:
{
  "how_you_know_each_other": "string — 1-2 sentences about how the operator knows this contact, inferred from the earliest messages in the transcript",
  "recent_topics": ["string", ...] — bullet list of distinct topics they've discussed in roughly the last 30 days. 3-6 items typical. Use plain noun phrases (e.g. \\"Their move to Lagos\\", \\"The book they recommended\\"). Empty array if nothing substantive in that window.",
  "inside_jokes": ["string", ...] — short list of recurring references, running jokes, or inside threads (a recurring nickname, a private bit, a callback that reappears across messages). Empty array if there aren't any clear ones - do not invent.",
  "vibe": "string — 1-2 sentences on the tone and feel of the relationship as it shows up in this transcript. Honest, not flattering."
}

Reminder: lines starting with \`operator:\` are the operator's own words; lines starting with \`contact:\` are the other person. Never paraphrase one as if it were the other.

Hard rules:
- Stick to what is literally in the transcript. Do not invent context.
- If the history is thin, say so. "Not enough yet" beats fabrication.
- British English, calm and direct.

Recipient: ${input.displayName}

Transcript:
${transcript}`;

    const { result } = await modelJson(prompt, fallback, (value) =>
      friendshipSummarySchema.parse(value)
    );
    return result;
  }

  /**
   * Free-form Q&A about a person (Q10). Grounded in:
   *   - every message across every thread the operator has with them
   *   - their enrichment snapshot (if one exists)
   *   - operator-supplied notes / tags
   *
   * Hard rules baked into the prompt:
   *   - Only answer from the provided context. If the context doesn't
   *     contain the answer, say so honestly ("we haven't discussed it").
   *   - Allowed to cite specific dates from message timestamps
   *     ("on March 4 they said..."). Verbatim quoting is fine.
   *   - Operator vs contact attribution discipline applies (already
   *     reinforced in SYSTEM_PROMPT).
   */
  async function askAboutPerson(input: {
    displayName: string;
    question: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    contact?: ContactProfileSnapshot | null;
    notes?: string | null;
    tags?: string[];
  }): Promise<{ answer: string }> {
    const fallback = { answer: "AI service is unavailable - try again in a moment." };
    const trimmed = input.question.trim();
    if (!trimmed) {
      return { answer: "" };
    }

    const transcript =
      input.messages.length > 0
        ? input.messages
            .map((m) => {
              const speaker = m.direction === "OUT" ? "operator" : "contact";
              return `${speaker} (${m.timestamp}): ${m.text}`;
            })
            .join("\n")
        : "(no messages on record)";

    const contactBlock = input.contact
      ? `Contact enrichment (do NOT invent fields not present here):\n${JSON.stringify(
          snapshotForPrompt(input.contact)
        )}`
      : "Contact enrichment: (none on record)";

    const notesLine = input.notes ? `Operator notes: ${safeTruncate(input.notes, 600)}` : "Operator notes: (none)";
    const tagsLine =
      input.tags && input.tags.length > 0 ? `Tags: ${input.tags.join(", ")}` : "Tags: (none)";

    const prompt = `Return strict JSON matching this exact shape:
{
  "answer": "string"
}

You are answering a question the operator is asking about this contact. Answer briefly (1-4 sentences) and use British English.

HARD RULES (strict):
- Only answer using the provided context (transcript + enrichment + notes). If the context doesn't contain the answer, say so plainly: "We haven't discussed this" or "Not on record" - do not guess or extrapolate.
- When relevant, cite specific dates from the message timestamps in your answer, e.g. "On 4 March 2025 they said they were moving to Lagos." Pull dates from the timestamp prefix on each transcript line. Verbatim short quotes are fine.
- Lines prefixed \`operator:\` are the operator's own words; \`contact:\` are the other person. Never paraphrase one as if it were the other.
- Do not fabricate names, dates, jobs, locations, or any facts not in the context.

Contact: ${input.displayName}

${contactBlock}
${notesLine}
${tagsLine}

Transcript (oldest first):
${transcript}

Question:
${safeTruncate(trimmed, 1_000)}`;

    const { result } = await modelJson(prompt, fallback, (value) =>
      askAboutPersonSchema.parse(value)
    );
    return result;
  }

  /**
   * Optional triage of a pilot bug / feedback report. Operates ONLY on the
   * tester's typed words and safe metadata — never a screenshot, never
   * message content. Returns null when the AI service is unavailable or
   * the call fails; the raw report is forwarded regardless.
   */
  async function summarisePilotReport(input: {
    type: string;
    title: string;
    description: string;
    expected: string;
    meta: Record<string, unknown>;
  }): Promise<PilotReportTriage | null> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }
    const prompt = `Triage this report from a small pilot of Relationship Inbox OS, a calm reply-workspace app. Turn the tester's own words into a short developer note. Use ONLY the report text and metadata below — do not invent details or assume features that are not mentioned.

Return strict JSON matching this exact shape:
{
  "summary": "string — 1-2 sentence developer-facing summary",
  "area": "string — likely area of the app (e.g. Today, Inbox, Thread page, LinkedIn scan, Settings, AI drafts)",
  "severity": "low" | "medium" | "high",
  "repro": ["string", ...]
}

Rules:
- British English, plain and calm. No marketing language.
- severity: high = blocks core use, medium = wrong or confusing but still usable, low = minor, or any feedback / feature-idea note.
- repro: short ordered steps, only if the report describes them. Empty array for feedback or feature-idea reports, or when no steps are given.

Report type: ${input.type}
Title: ${safeTruncate(input.title, 300)}
What happened: ${safeTruncate(input.description, 4000)}
Expected: ${safeTruncate(input.expected, 2000)}
Safe metadata: ${safeTruncate(JSON.stringify(input.meta), 1200)}`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = z
        .object({
          summary: z.string(),
          area: z.string(),
          severity: z.enum(["low", "medium", "high"]),
          repro: z.array(z.string()).default([])
        })
        .parse(parseAiJson(content, model));
      return {
        summary: applyVoiceRules(parsed.summary),
        area: applyVoiceRules(parsed.area),
        severity: parsed.severity,
        repro: parsed.repro.map((step) => applyVoiceRules(step)).filter((step) => step.length > 0)
      };
    } catch (error) {
      console.warn(
        `[ai] summarisePilotReport failed (provider=${provider}, model=${model}); skipping triage. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  /**
   * Conversation-end classifier (#287 phase 2.5). Returns "closed" when
   * the AI judges the last inbound to be a natural endpoint with no
   * implicit ask, "open" when the operator still owes a reply, and null
   * when the provider was unavailable. The caller uses null to mean
   * "leave the existing verdict and the heuristic in charge" (i.e. fail
   * open in the dashboard).
   *
   * The prompt receives only the last 1-3 messages plus the rolling
   * summary, so the token cost is low (~150 in, ~10 out). Caching by
   * last-inbound hash means each thread is classified at most once per
   * new inbound message.
   */
  async function classifyThreadClosed(input: {
    displayName: string;
    /** Oldest-first; the prompt examples include direction labels so
     *  attribution discipline applies. */
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    summary?: string | null;
  }): Promise<"closed" | "open" | null> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }

    // Send the last 3 turns oldest-first so the model sees the closing
    // beat plus the operator's preceding message for context.
    const recentTurns = input.messages
      .slice(-3)
      .map((m) => ({
        direction: m.direction,
        text: safeTruncate(m.text, 600)
      }))
      .filter((m) => m.text.trim().length > 0);

    if (recentTurns.length === 0) {
      return null;
    }

    // No inbound at all means the operator was last to speak; the
    // thread is by definition waiting on them and the LLM call is
    // skipped to save tokens. The dashboard already treats OUT-direction
    // as "not closed" through the heuristic too.
    const hasInbound = recentTurns.some((t) => t.direction === "IN");
    if (!hasInbound) {
      return "open";
    }

    const summaryLine = input.summary?.trim()
      ? `Summary so far: ${safeTruncate(input.summary, 600)}`
      : "Summary so far: (none)";

    const prompt = `${CLOSED_STATUS_PROMPT}

Person name: ${input.displayName}
${summaryLine}
Recent messages (oldest first):
${recentTurns.map((m, i) => `${i + 1}. [${m.direction}] ${m.text}`).join("\n")}`;

    try {
      const response = await client.chat.completions.create({
        model,
        ...(shouldUseJsonResponseFormat(provider, model)
          ? { response_format: { type: "json_object" as const } }
          : {}),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: reinforceJsonPrompt(prompt, model) }
        ],
        ...providerOptions(provider, model),
        ...geminiExtraBody(provider, model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = closedStatusSchema.parse(parseAiJson(content, model));
      return parsed.status;
    } catch (error) {
      console.warn(
        `[ai] classifyThreadClosed failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply,
    classifyThreadCategory,
    classifyThreadClosed,
    generateContactSummary,
    generateConversationStarters,
    composeInVoice,
    suggestSnoozeTimings,
    summarisePersonForFriendship,
    askAboutPerson,
    summarisePilotReport
  };
}
