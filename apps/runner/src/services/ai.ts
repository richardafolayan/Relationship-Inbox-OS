import OpenAI from "openai";
import type { SummaryOutput, SuggestedRepliesOutput, AiSource } from "@inbox-os/core";
import { z } from "zod";
import { runnerConfig, type AiProvider } from "../config";
import { safeTruncate, stripUnpairedSurrogates } from "../platforms/utils";
import type {
  AiService,
  ContactProfileSnapshot,
  ConversationStartersOutput,
  ConversationStarterCitedField,
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
  "- Keep replies to 1-2 sentences.",
  "- Match the inbound message's register. Warm if they're warm, formal if they're formal.",
  "",
  "If the inbound is a sales pitch, recruitment outreach, marketing, InMail, or cold solicitation, replace the \"Clarifying question\" reply with a \"Polite decline\" (a short, friendly \"not interested\" reply, ~1 sentence)."
].join("\n");

// System prompt for `composeInVoice`. The generic SYSTEM_PROMPT describes
// voice abstractly; this one shows it. Voice patterns + four verbatim
// few-shot exemplars covering the four situations the composer hits most:
// quick ack, warm reconnect, cold-pitch decline, sparking a real
// conversation off a post. Output rules at the end keep the model from
// over-polishing or faking typos.
export const COMPOSE_VOICE_SYSTEM_PROMPT = [
  "You are writing LinkedIn messages as Richard, in his voice. British English. Conversational, peer-to-peer.",
  "",
  "VOICE PATTERNS",
  "",
  "Openers:",
  "- Warm replies: \"Hey,\", \"Hey [name],\", \"Hey [name]!\", \"Hey [name]!!\"",
  "- Reconnects after a gap: \"Hey long time man\" or similar warm phrase before getting into the answer.",
  "- Cold decline: opens with \"Hey appreciate you reaching\" without a formal greeting.",
  "",
  "Casual register:",
  "- \"man\" is available as a casual address (see Examples A, B, D — \"appreciate that man\", \"long time man\", \"im good man\", \"congrats man\", \"really impressive man\"). Use it where it fits, never condescending. It's part of his register, not a checkbox.",
  "- Lowercase \"i\" and \"im\" appear naturally. Don't force capital I throughout.",
  "- Contractions are normal: \"I'm\", \"it's\", \"you're\", \"don't\". Sometimes \"im\" without apostrophe.",
  "- Comma-heavy run-on sentences are natural to him. Don't force short staccato sentences.",
  "- British English throughout.",
  "",
  "Vocabulary that sounds like him:",
  "- \"really appreciate that\", \"appreciate you reaching\", \"appreciate you asking\"",
  "- \"to be honest\", \"tbf\" (to be fair), \"actually\"",
  "- \"yh\", \"yhh\", \"yeah\", \"yeahh\"",
  "- \"tho\", \"moretime\" (UK slang for \"again/anyway\"), \"lil bit\"",
  "- Closings: \"Hope you're good\", \"Thank you though\"",
  "",
  "Affirmation vocabulary when responding to good news:",
  "- \"that's so good\", \"really good\", \"good to hear\"",
  "- \"really impressive\", \"really appreciate that\", \"appreciate you sharing\"",
  "",
  "Banned vocabulary (these are not in his register):",
  "- \"gig\" — sounds like freelancer/corporate slang. Use \"job\" or \"work\".",
  "- \"smashing it\", \"killing it\", \"crushing it\", \"nailing it\" — hype-affirmation phrases. Use the plain affirmations above instead.",
  "- Avoid temporal hedges like \"right now\" or \"at the moment\" unless the timing is genuinely the point.",
  "",
  "Reciprocity (the core move):",
  "- Match the length and energy of their message. Short ack from them gets a short reply. Long thoughtful message gets a long thoughtful reply.",
  "- Where possible, ask something genuine about them based on context. Could be their profile, could be what they shared in the message itself.",
  "- The goal is finding common ground quickly and making them feel comfortable.",
  "",
  "FEW-SHOT EXAMPLES",
  "",
  "Example A. Quick acknowledgement of a compliment.",
  "Their message: \"Hey Richard, just wanted to say I really enjoyed your latest post about delegation. Resonated a lot.\"",
  "Richard's reply: \"Hey, really appreciate that man, what was it that resonated with you?\"",
  "",
  "Example B. Warm reconnect after a gap.",
  "Their message: \"Hey, hope you're well! How's Creality Studio been going? Curious what you've been working on lately.\"",
  "Richard's reply: \"Hey long time man, yhh things are going pretty good to be fair, and yeahh im good man, Creality Studio has been pretty good, lot of pivoting and trying to figure out what it is i want to do though, but i think i've got what it is im doing, appreciate you asking tho, moretime, how have you been? Hope you're good.\"",
  "",
  "Example C. Polite cold pitch decline.",
  "Their message: \"Hey Richard, I help agencies like yours hit page 1 of Google with proven SEO systems. Got 5 mins for a quick call this week?\"",
  "Richard's reply: \"Hey appreciate you reaching but I'm not interested in this. Thank you though.\"",
  "",
  "Example D. Sparking a real conversation off someone's post.",
  "Context: They posted about leaving their corporate job to go solo, talking about how scary the leap was and how they're figuring out their offer now.",
  "Richard's reply: \"Hey [name], just saw your linkedin post about how scary it was to take the leap, and how you're figuring out your offer now, congrats man, that's so good, felt like i had to say this personally, it's really impressive man\"",
  "",
  "OUTPUT RULES",
  "",
  "- Don't introduce deliberate typos. Richard's real messages have typos because he types fast. You shouldn't fake them. But also don't over-polish, keep the conversational register.",
  "- HARD RULE — sentence starts get a capital letter. After every full stop, question mark, or exclamation mark, the very next character that starts the next sentence MUST be uppercase. Lowercase \"i\" as a pronoun mid-sentence is fine, but \". sounds like\" or \"? what are you\" is a fail, that's bad grammar, not voice. Read your output back and check this before returning.",
  "- Prefer comma chains over full stops in mid-message flow. One long comma-chained run feels closer to his actual style than back-to-back short sentences. The Reiss-style shape is one opener, one comma chain, optional question at the end, not three separate sentences glued together.",
  "- Don't end with a question if the situation doesn't warrant one. Cold decline is ack-only, no follow-up question.",
  "- When unsure how long the reply should be, err shorter. Long replies should feel earned by the depth of what they said.",
  "- No em dashes, en dashes, semicolons, or colons.",
  "- HALLUCINATION GUARD (strict). ONLY use details that are literally in their message or in the thread history. The test: if you can't quote the relevant phrase back from their text, don't include it. \"Enjoying it\" does NOT license \"new gig\", \"steep learning curve\", \"smashing it\", or any other invented context, even if it sounds plausible. Stick to the words they actually used or close synonyms. Don't invent job context, emotional context, motivations, or backstory. Don't add compliments they didn't earn. Phrases like \"appreciate you sticking with it\", \"glad you reached out\", \"thanks for being patient\" are forbidden unless they said something that warrants them. Voice-y filler that makes invented claims about their state — e.g. \"no drama there\", \"sounds like you've got a lot on\", \"sounds like a proper [anything]\" — counts as invented content too. If you're tempted to add warmth or context that isn't grounded in what they wrote, cut it. Voice MARKERS (\"man\", \"yhh\", \"tho\", \"tbf\", \"moretime\") are exempt from this guard — they're register, not claims about the recipient.",
  "- Names go at the start in the \"Hey [name],\" form. Do NOT embed names mid-sentence (\"Hey appreciate you reaching Marcus but\" is wrong). For cold declines specifically, the name can be omitted entirely if the message reads more natural without it, see Example C.",
  "- Don't greet by name unless the intent does.",
  "- If a late-reply acknowledgement is requested, the phrasing should fit the voice, not stand out as a templated apology."
].join("\n");

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

// Strip the punctuation forms the system prompt forbids. Defensive — even
// with the rule in the system message, GPT-5 sometimes slips in an em-dash
// or a colon. Apply to every text-producing AI call before persisting /
// returning to the dashboard.
const FORBIDDEN_PUNCTUATION_RE = /[—–]|;|:/g;
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
// Static analysis would flag FORBIDDEN_PUNCTUATION_RE as unused; keep it
// exported only via the side-effect of being referenced in tests if added.
void FORBIDDEN_PUNCTUATION_RE;

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
  // Z.AI's chat-completions endpoint is OpenAI-compatible at the wire level,
  // so reusing the OpenAI SDK with a different baseURL + key is the whole
  // integration. The provider choice is resolved per-call from SettingsStore
  // so a dashboard toggle takes effect without restarting the runner.
  const openAiClient = runnerConfig.openAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.openAiApiKey })
    : null;
  const glmClient = runnerConfig.zAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.zAiApiKey, baseURL: runnerConfig.zAiBaseUrl })
    : null;

  // Per-provider client + model resolution. The set of clients is built
  // once at startup; any new provider added here also needs an entry in
  // `providerRegistry` (see ./ai-providers).
  function resolveProvider(providerId: AiProvider): { client: OpenAI | null; model: string } {
    if (providerId === "glm") {
      return { client: glmClient, model: runnerConfig.glmModel };
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
    parser: (value: unknown) => T
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
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt }
          ],
          ...gpt5OptionsForModel(model)
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
        return { ok: true, result: parser(JSON.parse(content)) };
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
    parser: (value: unknown) => T
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
      const outcome = await tryProvider(providerId, model, prompt, parser);
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
  }): Promise<SummaryOutput> {
    const lastInbound = [...input.messages].reverse().find((msg) => msg.direction === "IN");
    const lastMessage = input.messages[input.messages.length - 1];

    const fallback: SummaryOutput = {
      summary: input.previousSummary ?? `Conversation with ${input.displayName}.`,
      // safeTruncate splits on Unicode code points so a 140-char cut won't
      // bisect an emoji's surrogate pair. Without it, a message ending in
      // an emoji at the boundary corrupts every subsequent prisma.thread
      // .update — see Sarah Nwisi sync-fail bug.
      what_they_want: lastInbound ? safeTruncate(lastInbound.text, 140) : "No clear ask yet.",
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
    const prompt = `Return strict JSON matching this exact shape:
{
  "summary": "string — 1-2 sentence rolling summary of the relationship",
  "what_they_want": "string — what would deepen this connection or make a great reply. If they made an explicit ask (book a call, share a date, answer a question), that goes here. Otherwise, name what's worth acknowledging or following up on (a thing they shared, a hook in their last message, the warmth they extended). One or two short sentences, plain prose, British English.",
  "open_loops": ["string", ...],
  "tone_notes": ["string", ...],
  "needs_reply": true | false,
  "urgency_hint": "string or omit if none"
}

Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Messages: ${JSON.stringify(input.messages)}`;

    const { result } = await modelJson(prompt, fallback, (value) => summarySchema.parse(value));
    return result;
  }

  async function generateSuggestedReplies(input: {
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    lastInboundMessage: string;
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
colons. Match the inbound message's register: warm if they're warm,
formal if they're formal.

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
  them specific to what was actually said.

${
  isOutreach
    ? `This thread is OUTREACH (sales pitch, recruitment, InMail, cold solicitation). Reply C MUST be a friendly Polite decline (~1 sentence, no commitment, no follow-up question), labelled with intent "Polite decline". Replies A and B can still pick intents that fit.`
    : ""
}${lateReplyHint}

Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Last inbound: ${input.lastInboundMessage}`;

    const { result: parsed, source } = await modelJson(prompt, fallback, (value) => repliesSchema.parse(value));
    // Defensive scrub of em-dashes, semicolons, colons — see applyVoiceRules.
    return {
      ...parsed,
      replies: parsed.replies.map((r) => ({
        ...r,
        text: applyVoiceRules(r.text)
      })),
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
        ...gpt5OptionsForModel(model)
      });

      const raw = response.choices[0]?.message?.content?.trim() || input.text;
      return applyVoiceRules(raw);
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

    const prompt = `Classify this LinkedIn thread as either:

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

Return strict JSON: { "category": "outreach" | "genuine" }

Person name: ${input.displayName}
${summaryLine}
${whatTheyWantLine}
Inbound messages (oldest first):
${inboundMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

    try {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = categorySchema.parse(JSON.parse(content));
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
    const prompt = `Summarise who this contact is in 2 to 3 sentences for the operator.
Lead with their current role or focus, then any clear commonality with the operator (shared school, shared work area, shared interest). If the operator's profile is null, omit the commonality and just describe the contact.

Style:
- British English. Conversational, like a peer briefing a peer.
- No em dashes, en dashes, semicolons, or colons.
- Plain prose. No headings, bullet points, or labels.
- Stick to facts that are present in the data. Do not invent details.

Return strict JSON: { "summary": "string" }

Contact profile: ${JSON.stringify(contactPayload)}
Operator profile: ${JSON.stringify(selfPayload)}`;

    try {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = z.object({ summary: z.string().min(1) }).parse(JSON.parse(content));
      return applyVoiceRules(stripUnpairedSurrogates(parsed.summary));
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
    contact: ContactProfileSnapshot;
    self: ContactProfileSnapshot | null;
  }): Promise<ConversationStartersOutput | null> {
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = startersSchema.parse(JSON.parse(content));
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

    const prompt = `Rewrite the operator's intent below as a complete, sendable LinkedIn message in Richard's voice. Match the length and energy of the recipient's last message (reciprocity rule from system prompt). When in doubt, err shorter. The voice samples below are additional calibration for this thread, the few-shot examples in the system prompt are the primary reference.

Operator's intent: ${safeTruncate(trimmed, 600)}

Recipient: ${input.displayName}

Recent voice samples (operator's own past messages on this thread, oldest first):
${cleanedSamples.length > 0 ? cleanedSamples.map((s, i) => `${i + 1}. ${safeTruncate(s, 320)}`).join("\n") : "(no prior outbound on this thread — match general British peer-to-peer warmth)"}
${lastInbound ? `\nLast message from recipient: ${safeTruncate(lastInbound.text, 400)}` : ""}${lateReplyHint}${relationshipHint}

Return strict JSON: { "text": "string" }`;

    try {
      const response = await client.chat.completions.create({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COMPOSE_VOICE_SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(model)
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return trimmed;
      const parsed = z.object({ text: z.string().min(1) }).parse(JSON.parse(content));
      return applyVoiceRules(stripUnpairedSurrogates(parsed.text));
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        ...gpt5OptionsForModel(model)
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
        .parse(JSON.parse(content));
      return parsed;
    } catch (error) {
      console.warn(
        `[ai] suggestSnoozeTimings failed (provider=${provider}, model=${model}); returning empty list. ${classifyLlmError(error, provider)}`
      );
      return { suggestions: [] };
    }
  }

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply,
    classifyThreadCategory,
    generateContactSummary,
    generateConversationStarters,
    composeInVoice,
    suggestSnoozeTimings
  };
}
