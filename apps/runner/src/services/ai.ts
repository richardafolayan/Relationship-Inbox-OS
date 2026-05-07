import OpenAI from "openai";
import type { SummaryOutput, SuggestedRepliesOutput } from "@inbox-os/core";
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

const summarySchema = z.object({
  summary: z.string(),
  what_they_want: z.string(),
  open_loops: z.array(z.string()),
  tone_notes: z.array(z.string()).default([]),
  needs_reply: z.boolean(),
  urgency_hint: z.string().optional()
});

/**
 * Classify an LLM provider error into a human-readable hint. Both
 * OpenAI and Z.AI's BigModel-compatible API surface structured
 * `code`/`status` on their SDK error objects; the function branches on
 * provider so the operator gets the right env-var name + the right
 * billing URL in the hint message.
 *
 * Returns a single string ready to splice into a `console.warn` line.
 */
export function classifyLlmError(error: unknown, provider: AiProvider): string {
  // Defensive duck-typing against `OpenAI.APIError`. We deliberately don't
  // import the type so a future SDK upgrade that renames the class doesn't
  // silently bypass this branch.
  const err = error as { code?: string; status?: number; message?: string } | undefined;
  const message = err?.message ?? String(error);
  const code = err?.code;
  const status = err?.status;
  if (provider === "glm") {
    // Z.AI's BigModel returns code 1113 for "insufficient balance" — surfaces
    // through the SDK as a 429 status with the body code stringified into the
    // message. Free-tier flash models bypass this; paid SKUs need a balance.
    if (status === 429 || code === "insufficient_quota" || /1113|insufficient.*balance|余额不足/i.test(message)) {
      return (
        "Reason: Z.AI account has no balance / no resource package (code 1113 / 429). " +
        "Free-tier flash models (e.g. glm-4.7-flash) bypass this. For paid SKUs, top up at " +
        "https://open.bigmodel.cn or https://api.z.ai, then retry."
      );
    }
    if (code === "model_not_found" || /model.*(not found|does not exist|invalid)/i.test(message)) {
      return `Reason: GLM model not available (${message}). Set Z_AI_MODEL to a valid id (e.g. glm-4.7-flash, glm-4.5-flash) and confirm against the pricing page — flash variants are free-tier and not always shown in /v4/models.`;
    }
    if (status === 401 || code === "invalid_api_key") {
      return "Reason: Z_AI_API_KEY is missing or invalid. Set it in .env and restart the runner, or recheck the dashboard provider toggle.";
    }
    return `Reason: ${message}.`;
  }
  if (code === "insufficient_quota" || status === 429) {
    return (
      "Reason: OpenAI account is out of credits (insufficient_quota / 429). " +
      "Top up at https://platform.openai.com/settings/organization/billing/overview, then retry."
    );
  }
  if (code === "model_not_found" || /model.*(not found|does not exist)/i.test(message)) {
    return `Reason: model not available to this account (${message}). Set OPENAI_MODEL to one your account has access to (e.g. gpt-4o-mini, gpt-4o, o1, o3-mini).`;
  }
  if (status === 401 || code === "invalid_api_key") {
    return "Reason: OPENAI_API_KEY is missing or invalid. Set it in .env and restart the runner.";
  }
  return `Reason: ${message}.`;
}

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

  async function resolveActive(): Promise<{ client: OpenAI | null; model: string; provider: AiProvider }> {
    // Settings.aiProvider is the live override; runnerConfig.aiProvider is
    // the cold-start default seeded from the AI_PROVIDER env var. Settings
    // reads are a single SQLite row lookup — cheap enough to do per call.
    const settings = await settingsStore.getSettings();
    const provider: AiProvider = settings.aiProvider ?? runnerConfig.aiProvider;
    if (provider === "glm") {
      const model = settings.glmModel?.trim() || runnerConfig.glmModel;
      return { client: glmClient, model, provider };
    }
    return { client: openAiClient, model: runnerConfig.openAiModel, provider };
  }

  async function modelJson<T>(prompt: string, fallback: T, parser: (value: unknown) => T): Promise<T> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return fallback;
    }

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
        console.warn(
          `[ai] ${provider} returned empty content (model=${model}); using fallback.`
        );
        return fallback;
      }

      return parser(JSON.parse(content));
    } catch (error) {
      console.warn(
        `[ai] ${provider} call failed (model=${model}); using fallback. ${classifyLlmError(error, provider)}`
      );
      return fallback;
    }
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
    const prompt = `Return strict JSON matching this exact shape:
{
  "summary": "string — 1-2 sentence rolling summary of the relationship",
  "what_they_want": "string — what the other person is asking for, in their words",
  "open_loops": ["string", ...],
  "tone_notes": ["string", ...],
  "needs_reply": true | false,
  "urgency_hint": "string or omit if none"
}

Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Messages: ${JSON.stringify(input.messages)}`;

    return modelJson(prompt, fallback, (value) => summarySchema.parse(value));
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
  }): Promise<SuggestedRepliesOutput> {
    const isOutreach = input.category === "outreach";
    const thirdIntent = isOutreach ? "Polite decline" : "Clarifying question";
    const fallback: SuggestedRepliesOutput = {
      replies: [
        {
          label: "A",
          intent: "Direct + helpful",
          text: "Thanks for the note. To be honest, that works for us."
        },
        {
          label: "B",
          intent: "Warm + relationship-first",
          text: "Appreciate you reaching out. Happy to keep this moving this week."
        },
        {
          label: "C",
          intent: thirdIntent,
          text: isOutreach
            ? "Thanks for reaching out, but it isn't something I'm looking at right now."
            : "Before we confirm, could you share the preferred timeline?"
        }
      ],
      needs_user_input: []
    };

    const prompt = `Return strict JSON matching this exact shape:
{
  "replies": [
    { "label": "A", "intent": "Direct + helpful", "text": "..." },
    { "label": "B", "intent": "Warm + relationship-first", "text": "..." },
    { "label": "C", "intent": "${thirdIntent}", "text": "..." }
  ],
  "needs_user_input": ["string", ...]
}

Each reply text must be a complete, sendable message under 280 characters,
1-2 sentences, British English. No em dashes, en dashes, semicolons, or
colons. Match the inbound message's register: warm if they're warm,
formal if they're formal.

${
  isOutreach
    ? "This thread is OUTREACH (sales pitch, recruitment, InMail, cold solicitation). Reply C must be a friendly Polite decline (~1 sentence, no commitment, no follow-up question)."
    : ""
}

Summary: ${input.summary}
What they want: ${input.whatTheyWant}
Open loops: ${JSON.stringify(input.openLoops)}
Last inbound: ${input.lastInboundMessage}`;

    const parsed = await modelJson(prompt, fallback, (value) => repliesSchema.parse(value));
    // Defensive scrub of em-dashes, semicolons, colons — see applyVoiceRules.
    return {
      ...parsed,
      replies: parsed.replies.map((r) => ({
        ...r,
        text: applyVoiceRules(r.text)
      }))
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

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply,
    classifyThreadCategory,
    generateContactSummary,
    generateConversationStarters
  };
}
