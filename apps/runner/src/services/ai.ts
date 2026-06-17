import OpenAI from "openai";
import type {
  PlatformName,
  SummaryOutput,
  SuggestedRepliesOutput,
  RememberItem,
  AiSource,
  ReplyBrief
} from "@inbox-os/core";
import { isNonContentIMessageSystemEvent } from "@inbox-os/core";
import { z } from "zod";
import { runnerConfig, type AiProvider } from "../config";
import { safeTruncate, capAskSummary, stripUnpairedSurrogates } from "../platforms/utils";
import {
  mirrorRequiredToOpenLoops,
  sanitizeReplyBrief,
  stripBannedPhrases,
  synthesiseFallbackBrief
} from "./reply-brief";
import type {
  AiService,
  ComposedFocusNote,
  ContactProfileSnapshot,
  ConversationStartersOutput,
  ConversationStarterCitedField,
  FriendshipSummaryOutput,
  InferredReplyStyle,
  MessageForPrompt,
  OperatorProfile,
  PilotReportTriage,
  SettingsStore,
  StyleProfile
} from "../types/runtime";
import { describeContactStyle, describeOperatorStyle } from "./style";
import { looksLikeNamelessRecipient } from "./name-inference";
import {
  buildReplyStyleAnalysisPrompt,
  emptyInferredStyle,
  normaliseInferredStyle,
  replyStyleAnalysisSchema
} from "./reply-style-analysis";
import { describeReactionsForPrompt, parseReactionsFromRawJson } from "./reaction-effects.js";
import {
  providerRegistry,
  fallbackChain,
  pickActiveProvider,
  classifyLlmError as classifyLlmErrorImpl,
  type AiErrorClassification
} from "./ai-providers";
import { raceAiProviders } from "./ai-race";

// Re-exported so existing tests + callers continue to import from ai.ts.
export const classifyLlmError = classifyLlmErrorImpl;

const summarySchema = z.object({
  summary: z.string(),
  what_they_want: z.string(),
  open_loops: z.array(z.string()),
  // Durable facts worth remembering (exams, trips, events). `date` is a
  // best-effort ISO string the model may also return as null or omit
  // entirely; normalizeRememberDate sanitises it after parsing.
  remember: z
    .array(
      z.object({
        note: z.string(),
        date: z.string().nullable().default(null)
      })
    )
    .default([]),
  tone_notes: z.array(z.string()).default([]),
  needs_reply: z.boolean(),
  urgency_hint: z.string().optional(),
  // The compressed Reply Brief that drives the thread right rail. Validated
  // loosely here (the model occasionally returns malformed point objects)
  // and re-sanitised by `sanitizeReplyBrief` post-parse, which enforces the
  // classification invariants (required/optional/handled mutually exclusive,
  // banned coaching phrases stripped, caps applied).
  reply_brief: z.unknown().optional()
});

// The model is asked for strict ISO YYYY-MM-DD dates but occasionally
// returns free text ("end of May"), a partial date, or an impossible one
// (2026-02-30). Anything that isn't a real calendar date in strict ISO
// form collapses to null so the dashboard's date maths never sees garbage.
function normalizeRememberDate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject values that don't round-trip (e.g. 2026-02-30 rolls to Mar 2).
  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

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
//
// `reason` is a one-line caption the dashboard renders alongside set-
// aside rows so the operator can see WHY a thread was closed without
// reading it. Without this the verdict feels like a black box.
const closedStatusSchema = z.object({
  status: z.enum(["closed", "open"]),
  reason: z.string().max(160)
});

// #287 phase 3.5. Reconnect score: a 0-100 integer for "how worth
// reaching out is this dormant relationship?" plus a single short reason
// the dashboard can surface as a quiet "why" caption. The model is asked
// to be conservative; the dashboard already orders dormants by simple
// relationship signals (outbound count, depth, recency) so a near-zero
// score just means "AI does not see a reason to nudge this one
// specifically", not that the relationship is worthless.
const reconnectScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().max(160)
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

// Issue #331. Per-loop verdict the model returns when it reads the
// operator's in-flight draft against the thread's open loops.
//   - "addressed": the draft genuinely answers / decides / confirms this
//     loop. The dashboard auto-ticks it at full_drafts.
//   - "partial": the draft mentions or touches the loop but doesn't
//     actually answer it. The dashboard leaves the row unticked and shows
//     a soft "partly covered" hint with the reason underneath, so the
//     operator knows why it didn't tick. (Issue #331 / R-0023.)
// Loops the model judges as fully unaddressed are omitted — the absence
// of a row is the signal, which keeps the wire small.
const draftCoverageItemSchema = z.object({
  loop: z.string(),
  status: z.enum(["addressed", "partial"]),
  reason: z.string().max(160).optional()
});
const draftCoverageSchema = z.object({
  items: z.array(draftCoverageItemSchema).default([])
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

/**
 * Issue #387. Inline fidelity reminder injected near the top of every
 * suggested-replies user prompt (and any other predraft user prompt that
 * wants the extra anchor). Reinforces the NO INVENTED FRAMING clause that
 * the voice prompts now carry — repeated at the per-call layer because
 * long voice scaffolds can fade from the model's attention by the time it
 * reaches the actual draft.
 *
 * Kept intentionally short. The voice prompts (CASUAL_VOICE_PROMPT /
 * FORMAL_VOICE_PROMPT) carry the worked example and the full ban list;
 * this constant is a top-of-context anchor, not a restatement.
 *
 * Exported so tests can assert the language is present in the assembled
 * prompt without snapshotting the whole template.
 */
export const PREDRAFT_FIDELITY_REMINDER = [
  "FIDELITY (read before drafting).",
  "Paraphrase the contact's stated facts in their register. Do NOT add emotional weight, stakes, significance, or characterisation they didn't express.",
  "If they paused a decision for a stated reason, acknowledge the stated reason — don't characterise it as a \"big move\", \"huge step\", \"exciting opportunity\", or anything else they didn't say. The interpretation must come from them, not you.",
  "Self-check before returning each reply: every substantive phrase should be traceable to something the contact actually said."
].join(" ");

/**
 * Issue #387 follow-up. Fidelity reminder for updateThreadSummary's
 * reply-brief generation. PREDRAFT_FIDELITY_REMINDER covered the predraft
 * generators in #389, but the brief generator was untouched — and its
 * on_you example literally said "that's the big thing worth acknowledging",
 * which the model dutifully reproduced on every Brandon-shaped thread.
 *
 * Same NO INVENTED FRAMING principle, applied at the brief level rather
 * than the reply-text level. where_it_stands / on_you / they_said must
 * paraphrase grounded facts without characterising them as "big", "weighty",
 * "main", "huge", "significant", etc.
 *
 * Exported so tests can assert the language is present in the assembled
 * prompt without snapshotting the whole template.
 */
/**
 * Issue #396 / #399. Contact-name discipline injected into every prompt
 * that produces user-facing text referencing the contact.
 *
 * Two pilot bugs in one shape:
 *   - #396: the model wrote "the contact" instead of using the person's
 *     actual name (e.g. "Ayo") even though we passed the name in.
 *   - #399: the model picked a name out of the transcript content
 *     (e.g. "Mayowa" appearing in one of the operator's own outbound
 *     messages) and used it as the contact's name, ignoring the
 *     authoritative displayName ("Ayo Johnson") in the prompt header.
 *
 * Same root cause: no explicit rule telling the model that the
 * recipient/displayName field is the SINGLE source of truth for the
 * contact's name, and that any name appearing in message bodies is
 * untrusted (could be a nickname, honorific, third party, friend's
 * name, etc.).
 *
 * Exported so tests can pin the language without snapshotting whole
 * prompt templates.
 */
export const CONTACT_NAME_DISCIPLINE = [
  "CONTACT NAME (strict).",
  "The contact's name is ALWAYS the value passed as \"Recipient: <name>\" / \"displayName\" in this prompt. Use that name (or a natural shortening of it — e.g. \"Ayo\" when the displayName is \"Ayo Johnson\") whenever you reference the contact in user-facing text.",
  "NEVER write \"the contact\", \"the user\", \"the recipient\", or \"the other person\" generically when the displayName is available. If the recipient is \"Ayo Johnson\" the brief says \"Ayo\" (or \"Ayo Johnson\"), not \"the contact\".",
  "NEVER pick a name from the transcript content. Operators sometimes write nicknames, honorifics, friends' names, third-party names, or random fragments in their own outbound messages. Those names are NOT the contact's name. \"Mayowa\" appearing inside an operator: message in a thread whose displayName is \"Ayo Johnson\" means the contact is still Ayo, not Mayowa.",
  "NEVER use the OPERATOR's own name as the contact's name. The operator's name appears in the \"WRITE AS THIS PERSON\" block when present, and it may also appear inside operator: lines if the contact addressed the operator by name (an inbound that opens \"Hi <operator's name>…\" or signs off \"Thanks <operator's name>\"). That name belongs to the operator — never to the contact. The contact's name is whatever the Recipient field says; when the Recipient name and the operator's configured name are different people, the brief and replies must reference the RECIPIENT's name, never the operator's. Confusing the two is the worst-case naming failure — re-read the recipient/displayName field if you're about to write a name and you're not sure which person you're naming. The bracketed placeholders in these rules (<operator's name>, <name>) are illustrative — NEVER output a bracketed placeholder, and NEVER output a name that appears only in these instructions; the only valid sources for a contact's name are the Recipient field and the transcript.",
  "If the displayName looks like a placeholder (\"+44…\", a phone number, an email, an empty string), it is acceptable to fall back to \"they/them\" or to omit a name. Do not invent one.",
  "GENDER / PRONOUNS (strict, #416). The system does NOT carry a pronoun signal on contacts. NEVER guess \"he\" or \"she\" from a name alone — gendered guesses on names you're unfamiliar with misfire often, and a wrong pronoun reads as careless. When unsure of pronouns: use the contact's name (\"Praise said she's free Friday\" → \"Praise is free Friday\") or fall back to \"they/them\". Acceptable signals for choosing he/she: the contact explicitly self-references in the transcript (\"my husband says…\", \"I'm pregnant\"), the operator has used a specific pronoun for them across multiple recent messages, or the displayName is a name you are HIGHLY confident maps to one gender across cultures (very rare — most names cross cultures). When in doubt, name-or-neutral always wins over a guess.",
  "TRANSCRIPT LABELS (strict, #463). In the transcript, the contact's own messages are prefixed with their name (the same value as Recipient/displayName) whenever it is known, and the operator's with \"operator:\". Those speaker labels are the ONLY authority on who the contact is. Any OTHER name that appears INSIDE a message body — whether the operator or the contact typed it — is a third party being discussed, NEVER the contact themselves. Worked example: in a thread whose contact is \"Lanre\", the name \"Anu\" mentioned inside the messages is a different person Lanre is talking about; the contact is still Lanre, and the summary must never call her Anu."
].join(" ");

/**
 * CONTACT_NAME_DISCIPLINE tells the model the contact's name is "the value
 * passed as `Recipient: <name>` / `displayName` in this prompt", and its
 * worked example uses the name "Seyi" ("if the recipient's displayName is
 * Seyi…"). That rule only works if the prompt actually CONTAINS a
 * `Recipient: <name>` line.
 *
 * The "Seyi" mislabel bug: two of the three prompts that injected the
 * discipline block — updateThreadSummary and generateSuggestedReplies —
 * never passed a Recipient line. The model got the naming RULE and the
 * example name but no real name to apply the rule to, so it labelled the
 * contact "Seyi" (the only proper noun in scope) across unrelated
 * low-signal threads ("Seyi mentioned that Boma can come" on a thread
 * whose contact is "The Jess"). composeInVoice passed the Recipient line
 * and was unaffected.
 *
 * Binding the rule and the name into ONE fragment makes it structurally
 * impossible to ship the discipline block without the name it points at.
 * Every prompt that needs contact-name discipline injects THIS — never
 * CONTACT_NAME_DISCIPLINE on its own. Placeholder displayNames (phone
 * numbers, emails, blank) are passed through verbatim; the discipline
 * text already routes those to a "they/them" fallback.
 *
 * Exported so tests can assert the rule and the name travel together.
 */
export function contactNameContext(displayName: string): string {
  // Placeholder displayNames (a bare phone number, an email, or a number-only
  // group chat like "+447…, +447…") carry no usable personal name. Passing the
  // raw handle as "Recipient: +447…" leaves the model with the naming RULE but
  // no name to apply it to, so it reaches into the discipline block's worked
  // example and mislabels the contact with the example name ("Seyi"). Give it
  // an explicit unknown-recipient instruction instead, filling the vacuum.
  const recipientLine = looksLikeNamelessRecipient(displayName)
    ? `Recipient: unknown contact or group chat — no name on file. Do NOT use a personal name for them. Refer to them as "they"/"them" (or "the group" for a group chat) unless a name is explicitly grounded in the transcript. NEVER borrow a name from the examples above.`
    : `Recipient: ${displayName}`;
  return `${CONTACT_NAME_DISCIPLINE}\n\n${recipientLine}`;
}

export function currentTimeContext(now: Date = new Date()): string {
  const iso = now.toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system local time";
  const localLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(now);
  return [
    "CURRENT TIME CONTEXT.",
    `Current date and time for the operator: ${localLabel}.`,
    `Current ISO timestamp: ${iso}.`,
    `System time zone: ${timeZone}.`,
    "Use this to resolve relative dates and clock times, and to judge whether a mentioned date or event has already passed. Keep the actual reply grounded in the transcript, do not invent timing that is not stated."
  ].join("\n");
}

export const BRIEF_FIDELITY_REMINDER = [
  "FIDELITY (applies to every visible brief field — where_it_stands, they_said, on_you).",
  "Paraphrase the contact's stated facts in their register. Do NOT add emotional weight, stakes, significance, or characterisation the contact did not express.",
  "If they paused a decision for a stated reason, name the reason — don't characterise it as a \"big thing\", \"big move\", \"hard call\", \"huge step\", \"weighty\", \"the main thing\", or anything else they didn't say.",
  "Worked example. Bad on_you: \"He's paused a job offer because the clients are in the Middle East — that's the big thing worth acknowledging\" (you invented \"big thing\"). Good on_you: \"He's paused a job offer because the clients were based in the Middle East. A short acknowledgement is enough.\"",
  "Self-check: every substantive phrase in the brief should be traceable to something the contact actually said in the transcript.",
  "NO INVENTED CADENCE (strict, #464). This applies to EVERY field including summary and what_they_want, not just the brief. Do NOT characterise the FORMAT, FREQUENCY, or TIMING of the messages themselves. Claims like \"single-word replies\", \"one-word messages\", \"you keep saying X\", \"rapid back-and-forth\", or \"for the last few minutes\" must be plainly and literally true of the recent transcript or be left out. Describe what was said, not how tersely, how often, or how recently it was said. A word that recurs in the messages (a topic, a name, a game like chess) is NOT evidence that the messages are one-word or repetitive."
].join(" ");

/**
 * Stale-beat bug ("Why is it referencing things that occurred ages ago, the
 * internship finished nearly a year ago?"). updateThreadSummary feeds up to
 * the most recent 120 messages, which on a long-running thread reaches back
 * many months. Every message carries an ISO timestamp and the prompt states
 * today's date, but the reply-brief sections had NO recency horizon — so the
 * model surfaced a one-off beat from ~10 months earlier ("I'm doing an
 * internship") in they_said and on_you as though it were current substance
 * the operator still owed a reply on, and even framed a 3-week-old exam as
 * happening "this week".
 *
 * This block defines the LIVE exchange and forbids dragging older background
 * into the live brief fields. The transcript also carries a code-computed
 * boundary line (LIVE_EXCHANGE_MARKER) so the model has an unambiguous cutoff
 * rather than only timestamps to reason about.
 *
 * Exported so tests can assert the language is present without snapshotting
 * the whole template.
 */
export const BRIEF_RECENCY_DISCIPLINE = [
  "RECENCY (strict, the brief is about the LIVE exchange, not the whole history).",
  "The transcript can span months. The LIVE exchange is the most recent inbound from the contact plus the messages clustered around it (roughly the last 2 to 3 weeks up to that inbound). When the transcript is long enough to have older history, a boundary line reading \"LIVE EXCHANGE BELOW\" marks where it starts: everything BELOW that line is the live exchange, everything ABOVE it is OLDER BACKGROUND.",
  "where_it_stands, they_said, on_you and required_points describe ONLY the live exchange. NEVER lift a beat out of the OLDER BACKGROUND into these fields as if it were current. A topic the contact raised once weeks or months ago and never returned to is NOT live reply debt.",
  "Use the per-message timestamps and today's date to judge age. A beat far older than the most recent inbound is stale (an internship mentioned ~10 months ago, an exam that was 3 weeks ago): keep it out of they_said / on_you / required_points, and never describe a long-past event as if it were happening \"this week\".",
  "A stale-but-durable fact (a job, a course, a house move) belongs in remember or durable_context, never the live brief. A stale loop that was genuinely never answered can go in handled_points with a reason, it does not become a required action.",
  "If the live exchange itself is old (the contact went quiet weeks or months ago) that is RECONNECT mode: set they_said to [] and do not mine the older background for substance."
].join(" ");

/**
 * Attribution reversal (same Annalise thread). The contact's own messages
 * said "you're nearly done with uni" and "congratulations on finishing uni",
 * addressed TO the operator. The brief flipped it into "Annalise finished
 * university, congratulate her", crediting the contact with the operator's
 * milestone and inverting the obligation (the operator should be THANKING
 * her for the congratulations, not congratulating her).
 *
 * "you"/"your" inside an inbound (contact) line refers to the OPERATOR;
 * inside an operator line it refers to the contact. This block pins that
 * resolution so a congratulation the contact sent the operator never becomes
 * the contact's own achievement.
 *
 * Exported so tests can assert the language is present.
 */
export const SECOND_PERSON_RESOLUTION = [
  "SECOND-PERSON RESOLUTION (strict, resolve every \"you\" against the speaker).",
  "In a contact (inbound / IN) line, \"you\" and \"your\" mean the OPERATOR, and \"I\"/\"me\"/\"my\" mean the contact. In an operator (OUT) line it is the reverse. Read the speaker label first, then decide who each pronoun points at.",
  "So if the contact writes \"you finished uni\", \"congrats on your new job\", \"well done on the move\", the achievement is the OPERATOR's: the contact is acknowledging the operator. NEVER record it as the contact's own milestone, and NEVER tell the operator to congratulate the contact for it.",
  "When the contact congratulates, thanks, or praises the operator, the obligation is to receive it (thank them, respond warmly), not to mirror it back as though the contact did the thing."
].join(" ");

/**
 * Operator-name third-party misresolution (issue #685, the "phone handover"
 * brief). Contacts often address the very person they are texting BY NAME,
 * in third person ("<name> come back", "<name> can you send the pics",
 * "who's on <name>'s phone"). TRANSCRIPT LABELS (#463) teaches that a name
 * inside a message body is a third party — correct for OTHER names, but it
 * left the operator's own name with no path back to the operator:
 * SECOND_PERSON_RESOLUTION above only covers pronouns, and the reassess
 * prompt never carried the operator's configured name at all. On a thread
 * where the contact teased "who's on <operator>'s phone… give the brother
 * his device back", the brief read the operator as a third party whose
 * device the operator holds and invented a "phone handover" errand across
 * where_it_stands / required_points / what_they_want.
 *
 * This fragment closes the gap: a name the contact uses to address, summon,
 * or talk about their 1:1 counterpart resolves to the OPERATOR (second
 * person), and the configured operator name is bound into the rule when one
 * exists — the same rule-and-name-travel-together shape as
 * contactNameContext(), so the rule can never ship without the name it
 * points at when a name is configured.
 *
 * Exported so tests can pin the language without snapshotting templates.
 */
export function operatorNameResolution(operatorDisplayName?: string | null): string {
  const parts = [
    "OPERATOR NAME RESOLUTION (strict — the operator has a name too).",
    "Contacts often address the very person they are texting BY NAME, in third person: \"<name> come back\", \"<name> can you send the pics\", \"who's on <name>'s phone\". In a 1:1 thread, a name the CONTACT uses to address, summon, tease, or talk ABOUT the person they are texting refers to the OPERATOR. Resolve it exactly like a second-person pronoun: it means \"you\" in every output field.",
    "The operator's own name must NEVER surface in output text as if it were a third party (\"the <name> device\", \"<name>'s update\", \"handling <name>\", \"the <name> handover\") — write \"you\"/\"your\" instead.",
    "This does NOT weaken the transcript-label rule: a name used this way is still NEVER the contact's name. And a genuinely different person who happens to share the name — clearly discussed as someone else (\"my cousin <name>\", \"<name> from work\") — stays a third party. When unsure in a 1:1 thread, a name used as direct address resolves to the operator.",
    "The bracketed placeholders here (<name>, <operator>) are illustrative — NEVER output a bracketed placeholder."
  ];
  const trimmed = typeof operatorDisplayName === "string" ? operatorDisplayName.trim() : "";
  if (trimmed) {
    parts.push(
      `The operator's configured name is "${trimmed}". When the contact writes that name in this thread, it refers to the OPERATOR unless the transcript clearly establishes a different person with the same name.`
    );
  }
  return parts.join(" ");
}

/**
 * Banter literalism (issue #685, same thread as operatorNameResolution's
 * doc). The contact spent an evening teasing that someone else must be on
 * the operator's phone ("I know your method", "give the brother his device
 * back"). The summariser took the bit literally and promoted it into
 * logistics: where_it_stands "planning the phone handover", a required
 * point "Outline next steps for handing <operator>'s phone" — and the
 * predraft then composed a reply around the invented errand. Casual threads
 * are full of jokes that pattern-match to tasks; nothing in the prompt said
 * an obligation must have been meant in earnest.
 *
 * Exported so tests can pin the language without snapshotting templates.
 */
export const BANTER_DISCIPLINE = [
  "BANTER IS NOT AN OBLIGATION (strict).",
  "Casual threads are full of teasing, jokes, playful accusations, hyperbole, and running bits (\"who's on your phone\", \"I'm blocking you\", \"you owe me dinner for this\"). Banter is register and tone — it is NEVER a task, plan, errand, or logistics item.",
  "Every obligation-bearing field — where_it_stands, what_they_want, on_you, required_points, open_loops, summary, durable_context — must trace to something the transcript states IN EARNEST: a real ask, commitment, plan, decision, or unresolved matter. If the only evidence for a task is a jokey exchange, the task does not exist.",
  "Self-check each required point and each claim in where_it_stands: could you point at a message where this was meant literally and seriously? If not, drop it. At most, banter can inform tone_steer (\"keep it playful — she's been teasing you\")."
].join(" ");

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

/**
 * Return the body string a prompt should render for this message.
 * Successful transcripts are folded in alongside (or in place of) the
 * existing text, in the same `[Voice message transcript: "..."]` shape
 * everywhere. Pending / failed / skipped states deliberately do NOT
 * append anything — the AI sees the message's original text only (the
 * iMessage adapter already substitutes "[Voice note]" when the message
 * has no text and only audio, so the AI still knows audio exists).
 */
export function renderMessageBody(
  message: Pick<MessageForPrompt, "text" | "audioTranscription" | "reactions">
): string {
  const transcription = message.audioTranscription;
  let body: string;
  if (
    transcription &&
    transcription.status === "transcribed" &&
    transcription.transcript &&
    transcription.transcript.trim().length > 0
  ) {
    const transcript = transcription.transcript.trim();
    const text = message.text ?? "";
    if (text.trim().length === 0) {
      body = `[Voice message transcript: "${transcript}"]`;
    } else {
      body = `${text} [Voice message transcript: "${transcript}"]`;
    }
  } else {
    body = message.text ?? "";
  }
  // Issue #393. Annotate the message with any tapback / reaction state
  // so the AI knows the operator reacted ❤️ instead of typing a reply
  // (or that the contact reacted to one of the operator's messages).
  // Empty string for plain messages with no reactions.
  const reactionNote = describeReactionsForPrompt(message.reactions ?? []);
  return reactionNote ? `${body}${reactionNote}` : body;
}

/**
 * Canonical `speaker (timestamp): body` line every prompt builder uses
 * for the bulk message log. Centralised so transcript injection (and any
 * future tweak to attribution shape) is a single edit. Divergent
 * formats elsewhere in this file (closed-status, reconnect-score,
 * draft-coverage) call `renderMessageBody` directly to keep their own
 * prefix shape while still benefiting from transcript injection.
 */
export function formatMessageForPrompt(
  message: MessageForPrompt,
  contactLabel = "contact"
): string {
  const speaker = message.direction === "OUT" ? "operator" : contactLabel;
  return `${speaker} (${message.timestamp}): ${renderMessageBody(message)}`;
}

// Reply-brief recency boundary (paired with BRIEF_RECENCY_DISCIPLINE). The
// reassess transcript can reach back months; this line marks where the LIVE
// exchange starts so the model has an unambiguous cutoff between current
// reply debt and older background, instead of inferring recency from the
// per-message timestamps alone.
export const LIVE_EXCHANGE_MARKER =
  "----- LIVE EXCHANGE BELOW (everything above is OLDER BACKGROUND, not live reply debt) -----";

// Window before the most recent inbound that still counts as the live
// exchange. 21 days: a normal back-and-forth spanning a couple of weeks
// reads as one live exchange, but a beat from months earlier falls outside
// it (the 10-month-old internship, the 3-week-old exam mention).
export const LIVE_EXCHANGE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Index of the first message in the LIVE exchange: the most recent inbound
 * plus any message within LIVE_EXCHANGE_WINDOW_MS before it. Messages MUST be
 * chronological (oldest first), the order resummarizeThread passes.
 *
 * Returns -1 when there is no boundary worth drawing:
 *   - no inbound at all (nothing to anchor recency on), or
 *   - the live exchange already starts at message 0 (the whole transcript is
 *     recent, so a short thread renders unchanged with no marker).
 */
export function liveExchangeStartIndex(messages: readonly MessageForPrompt[]): number {
  let mostRecentInboundTs: number | null = null;
  for (const m of messages) {
    if (m.direction !== "IN") continue;
    const ts = Date.parse(m.timestamp);
    if (Number.isNaN(ts)) continue;
    if (mostRecentInboundTs === null || ts > mostRecentInboundTs) {
      mostRecentInboundTs = ts;
    }
  }
  if (mostRecentInboundTs === null) return -1;
  const cutoff = mostRecentInboundTs - LIVE_EXCHANGE_WINDOW_MS;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const ts = Date.parse(msg.timestamp);
    if (Number.isNaN(ts)) continue;
    if (ts >= cutoff) {
      return i > 0 ? i : -1;
    }
  }
  return -1;
}

/**
 * Render the reassess transcript with LIVE_EXCHANGE_MARKER inserted at the
 * start of the live exchange, when there is older background above it.
 * Short / all-recent threads and threads with no inbound render exactly as
 * before, so the marker only appears when it actually separates old from new.
 */
export function buildReassessTranscript(
  messages: readonly MessageForPrompt[],
  contactLabel: string
): string {
  const liveStart = liveExchangeStartIndex(messages);
  return messages
    .map((m, i) => {
      const line = formatMessageForPrompt(m, contactLabel);
      return i === liveStart ? `${LIVE_EXCHANGE_MARKER}\n${line}` : line;
    })
    .join("\n");
}

/**
 * Issue #463 / #464 (pilot R-0062 / R-0063). The transcript used to label
 * every inbound turn generically as `contact:`. On a long, busy thread the
 * model would then latch onto a *name in the message content* and use it as
 * the contact's name — pilot saw a thread with "Lanre" summarised as if the
 * contact were "Anu" (a third party who recurs in the messages), and saw a
 * recurring word ("Chess") fabricated into "single-word messages saying
 * Chess". A header line ("Recipient: Lanre") plus CONTACT_NAME_DISCIPLINE
 * was not enough to beat dozens of in-content name mentions.
 *
 * The structural fix: bind the contact's real name to *their own turns* in
 * the transcript, so every inbound line reads "Lanre (ts): …". The model now
 * sees the authoritative name on every contact message, which dominates any
 * name buried in the content.
 *
 * Returns the contact's displayName when it reads as a real, single-person
 * name, else "contact" (preserving the previous behaviour) for:
 *   - empty / placeholder names,
 *   - comma-joined group participant lists ("Israel, Tim, Ayo") — a group
 *     turn can't be attributed to one name from this signal alone,
 *   - email handles and phone-number-shaped handles.
 * Group sender attribution (per-message senderName) is intentionally out of
 * scope here; unnamed/group threads keep the generic `contact:` label.
 */
export function contactTranscriptLabel(displayName: string | null | undefined): string {
  const name = (displayName ?? "").trim();
  if (!name) return "contact";
  if (name.includes(",")) return "contact"; // group / participant list
  if (name.includes("@")) return "contact"; // email handle
  if (/^\+?[\d\s().-]{6,}$/.test(name)) return "contact"; // phone-number-shaped handle
  return name;
}

/**
 * Whether a message should enter the AI prompt body at all.
 *
 * The two rules:
 *   - iMessage "kept an audio message" system events never enter the
 *     prompt. They're platform retention notices, not speech, and
 *     letting the model see them wastes tokens + risks misattribution.
 *   - Voice-only bubbles whose transcription failed / was skipped /
 *     is still pending don't enter as "[Voice note]" placeholders.
 *     With no transcript content there's nothing real for the model
 *     to ground on; the existing thread UI still shows the audio chip
 *     so the operator can see audio existed.
 *
 * Returns true for ordinary text turns and for voice-only messages
 * with a successful transcript. Used as the filter at every site that
 * hands a message log to a prompt builder.
 */
export function isAiVisibleMessage(
  message: Pick<MessageForPrompt, "text" | "audioTranscription">
): boolean {
  const text = (message.text ?? "").trim();
  if (isNonContentIMessageSystemEvent(text)) return false;
  const transcription = message.audioTranscription;
  const hasTranscript =
    !!transcription &&
    transcription.status === "transcribed" &&
    !!transcription.transcript &&
    transcription.transcript.trim().length > 0;
  if (text.length === 0 && !hasTranscript) return false;
  // Pure "[Voice note]" placeholder text (no transcript) should not
  // enter prompts as fake content. Other attachment placeholders are
  // left in place — the AI still benefits from knowing "[Photo]" was
  // sent even though it can't see images here.
  if (/^\[\s*voice notes?\s*\]$/i.test(text) && !hasTranscript) return false;
  if (/^\[\s*audios?\s*\]$/i.test(text) && !hasTranscript) return false;
  return true;
}

/**
 * Shape a Prisma Message row (optionally with the audioTranscription
 * relation included) into the `MessageForPrompt` the AI service
 * consumes. Callers that omit the relation pass through unchanged —
 * `audioTranscription` becomes null and the helpers above fall back to
 * the message text as before.
 */
export function prismaMessageToPrompt<
  T extends {
    direction: string;
    text: string;
    timestamp: Date | string;
    audioTranscription?: { status: string; transcript: string | null } | null;
    rawJson?: string | null;
  }
>(message: T): MessageForPrompt {
  const direction = message.direction === "OUT" ? "OUT" : "IN";
  const timestamp =
    typeof message.timestamp === "string" ? message.timestamp : message.timestamp.toISOString();
  // Issue #393. Pull reactions out of rawJson so the AI prompt builder
  // can annotate the message with "[operator reacted ❤️]" etc. Silently
  // returns [] when rawJson is missing, malformed, or has no reactions
  // key — the helper is defensive.
  const reactions = parseReactionsFromRawJson(message.rawJson ?? null);
  return {
    direction,
    text: message.text,
    timestamp,
    audioTranscription: message.audioTranscription ?? null,
    reactions: reactions.length > 0 ? reactions : undefined
  };
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
export const FORMAL_VOICE_PROMPT = [
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
  "- NO INVENTED FRAMING (subtler than the guard above). Don't assign emotional weight, stakes, significance, or characterisation the contact didn't express. If they state a fact neutrally (\"the clients were based in the Middle East, so I paused that offer\"), paraphrase the fact in their register — do NOT add \"big move\", \"huge step\", \"tough call\", \"exciting opportunity\", \"sounds like a lot\", or any other interpretation they didn't use. Worked example. Bad: \"Middle East is a big move so makes sense to hold off\" (you invented \"big move\" — they only said the clients were in the Middle East). Good: \"Fair enough on pausing that offer if the clients were based in the Middle East.\" Self-check: if a phrase in your reply explains why their choice is reasonable, hard, significant, or exciting — and they didn't say so themselves — cut it.",
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
  6. If the latest inbound is a deleted / retracted message placeholder
     ("This message has been deleted.", "This message was deleted",
     "Message unsent") it is not a real turn — the other party unsent
     what they wrote. Skip it and decide based on the prior real turn:
     if the prior real inbound is still after the last outbound and
     genuinely asks for something → OPEN; otherwise → CLOSED. Do not
     treat the placeholder itself as either a fresh ask or a closing
     beat.
  7. When in doubt → OPEN. False "closed" hides threads that might
     need the operator; false "open" just leaves them visible.

Examples:
  CLOSED — IN: "thanks so much, really appreciate it"
  CLOSED — IN: "perfect, see you Wednesday"
  CLOSED — IN: "👍"
  CLOSED — IN: "This message has been deleted." (and the prior real
            inbound did not leave a live question on the table)
  OPEN   — IN: "thanks - and one more thing, did the invoice clear?"
  OPEN   — IN: "hey, been ages! how have you been?"
  OPEN   — IN: "I'll send the doc later today, sound good?"
  OPEN   — IN: "This message has been deleted." (the prior real
            inbound was an unanswered direct question)
  OPEN   — OUT: "let me know what you think"

Return strict JSON: { "status": "closed" | "open", "reason": "<one short sentence, plain English, no more than 18 words>" }

Reason guidance:
  - Quote or paraphrase the actual closing beat ("she said cool see you Wednesday").
  - For OPEN, name the question or ask ("he asked when you're back from leave").
  - No greetings, no recommendations, no second-guessing the operator.
  - Lowercase fine. No em dashes, en dashes, semicolons, or colons.`;

// #287 phase 3.5. Reconnect-worthy scorer. Asked to rate, on a 0-100
// scale, how much it makes sense for the operator to send a deliberate
// "hey, been a while" message to this LinkedIn contact right now. The
// dashboard already ranks dormants by deterministic signals (outbound
// count, depth, recency); this prompt adds the qualitative read of the
// arc: did the relationship feel mutual? did the last exchange leave
// something open? does the contact's profile / role suggest a natural
// hook?
//
// The prompt is deliberately conservative: a score of 50 is "neutral,
// could go either way" and the model is reminded that "low" is fine —
// it does not have to manufacture reasons to message someone.
export const RECONNECT_SCORE_PROMPT = `Rate, from 0 to 100, how worth it would feel for the operator to send a deliberate "hey, been a while" message to this LinkedIn contact today.

A higher score means the relationship looks like one where a gentle reconnect is welcome AND there is a natural beat to hang it on (a topic from the prior arc, a role change, an unanswered thread of conversation, an obvious common ground). A lower score means the relationship feels transactional, the contact's last message clearly closed the conversation, or there is no specific reason to surface this one ahead of the rest.

Scoring guide:
  90-100 — Strong: real mutual relationship, the last exchange left a natural reopen point, or the contact's profile / topic gives an obvious hook.
  70-89  — Good: warm tie, the operator probably wants to keep this person in their orbit; reasonable to nudge.
  50-69  — Neutral: ordinary professional acquaintance; reconnecting is fine but no particular reason today.
  20-49  — Weak: thin relationship, transactional history, or the conversation already wrapped fully.
  0-19   — Discourage: cold pitch in disguise, fully one-sided, or the last exchange explicitly ended the relationship.

Decision rules:
  - Be conservative. When uncertain, lean toward the middle (40-60). False high scores nudge the operator into awkward outreach; that is worse than missing one.
  - Mutual back-and-forth depth is the single best signal. Long one-sided threads from a recruiter or pitch contact should score low.
  - The freshness of the dormancy matters: very long lulls (years) reduce the score unless there is a strong hook.
  - Do not invent details. If the inputs give you nothing specific to point to, the score belongs in the 40-60 band.

Return strict JSON: { "score": 0-100 integer, "reason": "<one short sentence, plain English, no more than 25 words>" }

Examples of good reasons (style only, not actual outputs):
  "you swapped notes on hiring last year and they just took a new role"
  "deep back-and-forth on the product side, last lull was after they moved jobs"
  "one-sided pitch thread, nothing to hang a hello on"`;

// Casual-DM voice profile. Applies on WhatsApp / iMessage / Instagram /
// TikTok DMs. A GENERIC scaffold: it sets the relaxed register without
// impersonating anyone. The current user's actual voice — their slang,
// emoji habits, phrasing — comes only from their configured profile,
// injected via operatorProfileFragment(). With no profile set, this
// produces a plain, natural, everyday casual style. It must never assume
// a specific identity, slang set, emoji palette, or nationality.
export const CASUAL_VOICE_PROMPT = `You are helping the operator write a casual message (WhatsApp, iMessage, Instagram DM, or TikTok DM) in their OWN voice — the relaxed, everyday register they would use with people they know.

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

NO INVENTED FRAMING (the subtler failure mode)
Do not assign emotional weight, stakes, significance, or characterisation the contact did not express. If they state a fact neutrally, paraphrase the fact in their register — do NOT editorialise it. The interpretation must come from them, not you.
- Worked example. They say "the clients were based in the Middle East, so I paused that offer" — grounded reply: "Fair enough on pausing that offer if the clients were based in the Middle East." NOT grounded: "Middle East is a big move so makes sense to hold off" (you invented "big move" — they never said moving was the issue).
- Banned moves: adding "big move", "huge step", "tough call", "exciting opportunity", "no pressure", "sounds like a lot", or any other phrase that characterises their decision or situation when they characterised it neutrally.
- Self-check before returning: if a phrase in your reply explains why their choice is reasonable, hard, significant, or exciting — and they did not say so themselves — cut it. The contact's actual wording always beats your interpretation of what they meant.

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

/**
 * Default reason rendered when the model's "partly covered" reason fails
 * the post-parse sanitiser (banned guilt phrasing, empty after stripping,
 * etc.). Calm, neutral, British English. Stays under the 120-char cap so
 * the dashboard sub-line never truncates.
 */
export const PARTIAL_REASON_FALLBACK = "Nearly covered. Add the missing detail before sending.";

/**
 * Issue #387. Grounding clause injected into the checkDraftCoverage
 * prompt. Extends the ADDRESSED/PARTIAL distinction so that a draft
 * which addresses a loop using framing the contact didn't express
 * counts as PARTIAL — not ADDRESSED — and the reason names the invented
 * framing. Without this clause the coverage check would happily tick
 * "Middle East is a big move" as addressing the paused-offer loop, even
 * though the contact never characterised it as a "big move".
 *
 * Exported so the fidelity tests can assert the language is present in
 * the assembled prompt without snapshotting the full template.
 */
export const DRAFT_COVERAGE_GROUNDING_CLAUSE = [
  "GROUNDING CHECK (counts as PARTIAL, not ADDRESSED).",
  "If the draft addresses the loop by adding emotional weight, stakes, significance, or characterisation the contact did not express, mark it PARTIAL — the reason should name the invented framing.",
  "Worked example. Contact said \"the clients were based in the Middle East, so I paused that offer\"; draft says \"Middle East is a big move so makes sense to hold off\" → PARTIAL with reason \"adds 'big move' framing the contact didn't use\".",
  "Mark ADDRESSED only when the draft engages with the loop using language traceable to what the contact actually said. When the draft adds interpretation the contact didn't express, prefer PARTIAL even if the topic is covered."
].join(" ");

/**
 * Substrings that turn a partial-coverage reason into guilt phrasing.
 * Tested case-insensitive against the trimmed reason. The model is
 * prompt-instructed to avoid these (see SYSTEM_PROMPT + checkDraftCoverage
 * prompt), but defence in depth: if one slips through, fall back to the
 * neutral PARTIAL_REASON_FALLBACK so the dashboard never renders
 * something that reads as a tick-off.
 */
const PARTIAL_REASON_BANNED_PHRASES = [
  "you forgot",
  "you missed",
  "you should have",
  "ignored",
  "neglected",
  "failed to"
];

/**
 * Clean and cap the "partly covered" reason returned from
 * checkDraftCoverage. Strips em / en dashes, replaces banned guilt
 * phrasing with the neutral fallback, and truncates to 120 chars so the
 * dashboard sub-line stays within its visual budget. Returns
 * `undefined` when the input is empty or whitespace-only so the caller
 * drops the row (a partial entry without a reason is dropped upstream).
 */
export function sanitisePartialReason(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return undefined;
  // Strip em / en dashes the system prompt forbids. Reuse the existing
  // applyVoiceRules so all post-parse paths converge on the same rule
  // (dash to comma, etc.).
  const cleaned = applyVoiceRules(trimmed);
  const lowered = cleaned.toLowerCase();
  for (const phrase of PARTIAL_REASON_BANNED_PHRASES) {
    if (lowered.includes(phrase)) {
      return PARTIAL_REASON_FALLBACK;
    }
  }
  if (cleaned.length === 0) return PARTIAL_REASON_FALLBACK;
  if (cleaned.length > 120) {
    return cleaned.slice(0, 120).trim();
  }
  return cleaned;
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

// #380 residual fix (R-0028). The draft generator (generateSuggestedReplies)
// used to pick REOPEN purely from a timestamp flag: any operator message
// newer than the contact's set needsReply=false, switching the drafts to
// "reach into a quiet thread" openers. A single reply to one of several
// contact topics tripped it, so the drafts stopped addressing the remaining
// points. #410 fixed the same flip in the summary path; this reuses that
// fix's output — the brief's required_points (the still-owed set, with
// handled/optional already excluded) and its legacy open_loops mirror —
// rather than re-deriving coverage. REOPEN only when the contact isn't
// waiting AND no reply debt remains.
export function selectSuggestedReplyMode(input: {
  needsReply: boolean;
  replyBrief?: ReplyBrief | null;
  openLoops?: string[];
}): "reply" | "reopen" {
  // Contact's last message is newer — they're waiting. Always reply.
  if (input.needsReply) return "reply";
  // Operator replied last. Stay in reply mode while substance is still owed.
  const remaining = (input.replyBrief?.required_points ?? [])
    .map((point) => point.text?.trim() ?? "")
    .filter((text) => text.length > 0);
  if (remaining.length > 0) return "reply";
  // Cold path with no brief: fall back to the legacy open_loops mirror.
  const loops = (input.openLoops ?? []).map((loop) => loop.trim()).filter((loop) => loop.length > 0);
  if (loops.length > 0) return "reply";
  // No pending message and no remaining debt — genuinely quiet thread.
  return "reopen";
}

/**
 * Render the recent exchange for generateSuggestedReplies as `speaker: body`
 * lines, oldest first. Operator turns are labelled `operator:`; contact turns
 * are labelled with `contactLabel`, which callers derive from
 * `contactTranscriptLabel(displayName)` so the contact's own messages are
 * prefixed with their REAL name when it is known.
 *
 * This is the anti-leak invariant the injected #463 TRANSCRIPT LABELS
 * discipline depends on: that block tells the model the contact's turns are
 * name-prefixed and are the only authority on who the contact is, so any
 * OTHER proper noun in a body is a third party. Previously this transcript
 * hardcoded `contact:`, leaving the discipline's claim unbacked and letting
 * the model address a reply to a body-mentioned third party (Lanre -> Anu,
 * #463/#399). For a placeholder handle `contactTranscriptLabel` returns
 * "contact", so nameless threads render exactly as before.
 *
 * Note: deliberately NOT `formatMessageForPrompt` — that adds a `(timestamp)`
 * and would change the prompt the suggested-replies model sees. This keeps
 * the historical `speaker: body` shape.
 */
export function renderSuggestedRepliesExchange(
  messages: MessageForPrompt[],
  contactLabel = "contact"
): string {
  return messages
    .map((m) => {
      const speaker = m.direction === "OUT" ? "operator" : contactLabel;
      return `${speaker}: ${renderMessageBody(m)}`;
    })
    .join("\n");
}

/**
 * Validate + post-process a raw model response for composeFocusNote
 * ("Help me phrase this"). Module-level and pure so the token discipline is
 * directly testable: both notes MUST keep [Name] and [until] literal — a
 * baked-in real name or clock time would mis-personalise or go stale at
 * send time — and a response that drops either token THROWS, which makes
 * modelJson walk to the next provider instead of accepting a broken note.
 * untilTime only survives as strict 24-hour "HH:MM"; anything else is null.
 */
export function parseComposedFocusNote(value: unknown): ComposedFocusNote {
  const parsed = z
    .object({
      close: z.string().min(1),
      professional: z.string().min(1),
      reason: z.string().default(""),
      untilTime: z.string().nullable().optional()
    })
    .parse(value);
  const requireTokens = (note: string, field: string): string => {
    const cleaned = enforceSentenceStartCapitals(applyVoiceRules(stripUnpairedSurrogates(note)));
    if (!cleaned || cleaned.length < 8) {
      throw new Error(`composeFocusNote: ${field} note too short`);
    }
    if (!cleaned.includes("[Name]") || !cleaned.includes("[until]")) {
      throw new Error(`composeFocusNote: ${field} note dropped a required token`);
    }
    return safeTruncate(cleaned, 500);
  };
  const reason = parsed.reason
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
  const untilTime =
    typeof parsed.untilTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.untilTime.trim())
      ? parsed.untilTime.trim()
      : null;
  return {
    close: requireTokens(parsed.close, "close"),
    professional: requireTokens(parsed.professional, "professional"),
    reason: safeTruncate(reason, 40),
    untilTime
  };
}

export function createAiService(settingsStore: SettingsStore): AiService {
  // Build one client per provider up front, guarded by API key presence.
  // Z.AI and Google's Gemini API both expose OpenAI-compatible chat
  // endpoints, so reusing the OpenAI SDK with a different baseURL + key is
  // the whole integration. The provider choice is resolved per-call from
  // SettingsStore so a dashboard toggle takes effect without restarting
  // the runner.
  // Cap each request: the SDK defaults to NO timeout, so a wedged TCP
  // connection would hang a user-visible call ("Drafting…") indefinitely.
  // maxRetries:0 because tryProvider() + the fallback chain already own
  // retries/fallback — the SDK's default 2 retries would multiply that.
  // 15s (was 30s): a healthy nano/flash call returns in ~2-5s, so 15s still
  // clears a slow-but-legit response while halving the worst-case stall a
  // single wedged provider can add before the fallback chain moves on — the
  // tail latency behind the "Reassess takes forever" complaint.
  const AI_CLIENT_OPTIONS = { timeout: 15_000, maxRetries: 0 } as const;
  const openAiClient = runnerConfig.openAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.openAiApiKey, ...AI_CLIENT_OPTIONS })
    : null;
  const glmClient = runnerConfig.zAiApiKey
    ? new OpenAI({ apiKey: runnerConfig.zAiApiKey, baseURL: runnerConfig.zAiBaseUrl, ...AI_CLIENT_OPTIONS })
    : null;
  const geminiClient = runnerConfig.geminiApiKey
    ? new OpenAI({ apiKey: runnerConfig.geminiApiKey, baseURL: runnerConfig.geminiBaseUrl, ...AI_CLIENT_OPTIONS })
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

  /**
   * Pick a race partner for the given active provider (issue #382).
   * Returns the first configured provider whose client is reachable
   * and whose id differs from the active one. Falls back to `null`
   * when no second provider is configured — in that case the caller
   * skips racing and runs a single modelJson call as before.
   *
   * Order preference: openai → glm → gemini (openai first because
   * latency is the most predictable; the goal of the race is to
   * shave the slow tail, not to swap models). The active provider
   * is filtered out so the race always pits two distinct providers.
   */
  function pickRaceSecondary(activeId: AiProvider): AiProvider | null {
    const ordered: AiProvider[] = ["openai", "glm", "gemini"];
    for (const candidate of ordered) {
      if (candidate === activeId) continue;
      if (resolveProvider(candidate).client) return candidate;
    }
    return null;
  }

  async function resolveActive(): Promise<{ client: OpenAI | null; model: string; provider: AiProvider }> {
    // Settings.aiProvider is the live override; runnerConfig.aiProvider is
    // the cold-start default seeded from the AI_PROVIDER env var. Settings
    // reads are a single SQLite row lookup — cheap enough to do per call.
    const settings = await settingsStore.getSettings();
    const requested: AiProvider = settings.aiProvider ?? runnerConfig.aiProvider;
    // Key-presence fallback: if the requested provider has no key but another
    // is configured, use that one. Lets an operator (e.g. a pilot) set just
    // ANY one key without also flipping AI_PROVIDER. Only providers with a
    // built client are considered configured.
    const configured: AiProvider[] = [];
    if (openAiClient) configured.push("openai");
    if (geminiClient) configured.push("gemini");
    if (glmClient) configured.push("glm");
    const providerId = pickActiveProvider(requested, configured);
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
   *
   * `opts.forceProviderId` — pin the chain to a single provider (still
   * honours that provider's retry budget). Used by the race wiring
   * (issue #382) to run two parallel modelJson calls against different
   * providers without each one walking its own fallback chain in
   * parallel. On all-attempts-fail returns the caller fallback with
   * `source.providerId = null`, just like the chained path.
   */
  async function modelJson<T>(
    prompt: string,
    fallback: T,
    parser: (value: unknown) => T,
    systemContent?: string,
    opts?: { forceProviderId?: AiProvider }
  ): Promise<{ result: T; source: AiSource | null }> {
    const { provider: activeId, model: activeModel } = await resolveActive();
    const chain: AiProvider[] = opts?.forceProviderId
      ? [opts.forceProviderId]
      : [activeId, ...fallbackChain.filter((id) => id !== activeId)];

    let activeFailure: AiErrorClassification | null = null;

    for (let i = 0; i < chain.length; i++) {
      const providerId = chain[i]!;
      // Honour the user's model-override for the active provider only.
      // When forceProviderId pins to a non-active provider (race wiring,
      // issue #382), use that provider's default model — the settings
      // override is tied to the user's primary selection, not to the
      // race partner.
      const isActiveProvider = providerId === activeId;
      const isFirstInChain = i === 0;
      const model = isActiveProvider ? activeModel : resolveProvider(providerId).model;
      const outcome = await tryProvider(providerId, model, prompt, parser, systemContent);
      if (outcome.ok) {
        const entry = providerRegistry[providerId];
        // `fellBack` describes the chain walk (active failed, fallback
        // ran). When forceProviderId is set, there was no walk to
        // describe — collapse to "no fallback" regardless.
        const fellBack = !opts?.forceProviderId && !isFirstInChain;
        const source: AiSource = {
          providerId,
          providerDisplayName: entry.displayName,
          fellBackFromProviderId: fellBack ? activeId : null,
          fellBackFromProviderDisplayName: fellBack ? providerRegistry[activeId].displayName : null,
          fellBackReason: fellBack ? activeFailure?.kind ?? null : null,
          fellBackMessage: fellBack ? activeFailure?.message ?? null : null
        };
        return { result: outcome.result, source };
      }
      if (isFirstInChain) {
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

  /**
   * Race two providers for `modelJson` (issue #382 — pilot R-0029).
   * Dispatches the same prompt against the active provider and one
   * pinned secondary in parallel and returns the FIRST one whose
   * response carries a real provider source (i.e. the underlying
   * tryProvider actually produced a result rather than exhausting
   * retries and returning the caller fallback).
   *
   * Behaviour:
   *   - When no second provider is configured, falls through to the
   *     normal chained modelJson — race is purely additive.
   *   - When both raced calls return the caller fallback (both
   *     providers exhausted), walks the chained modelJson path as a
   *     last resort. The chain re-tries the providers we just tried,
   *     but it's the only way to honour fallbackChain consistency
   *     with the non-race path; in practice both-fail is rare enough
   *     that the duplicate cost is acceptable.
   *
   * Use only for operator-initiated, user-visible AI calls. Doubles
   * provider spend per raced call.
   */
  async function raceModelJson<T>(
    prompt: string,
    fallback: T,
    parser: (value: unknown) => T,
    systemContent: string | undefined,
    raceLabel: string
  ): Promise<{ result: T; source: AiSource | null }> {
    const { provider: activeId } = await resolveActive();
    const secondaryId = pickRaceSecondary(activeId);
    if (!secondaryId) {
      return modelJson(prompt, fallback, parser, systemContent);
    }
    try {
      const outcome = await raceAiProviders<{ result: T; source: AiSource | null }>({
        primary: {
          providerId: activeId,
          call: () => modelJson(prompt, fallback, parser, systemContent, { forceProviderId: activeId })
        },
        secondary: {
          providerId: secondaryId,
          call: () => modelJson(prompt, fallback, parser, systemContent, { forceProviderId: secondaryId })
        },
        // Real provider source means the underlying tryProvider
        // succeeded; the caller fallback ships with source.providerId
        // === null, which is the signal we use to wait on the other
        // participant.
        validate: (value) => value.source !== null && value.source.providerId !== null
      });
      const loser = outcome.loser;
      const loserDescription =
        loser.kind === "still_running"
          ? `${loser.providerId}/still_running`
          : `${loser.providerId}/${loser.kind}/${Math.round(loser.durationMs)}ms`;
      console.log(
        `[ai-race ${raceLabel}] winner=${outcome.winnerProviderId}/${Math.round(outcome.winnerDurationMs)}ms ${loserDescription}`
      );
      return outcome.result;
    } catch (error) {
      console.warn(
        `[ai-race ${raceLabel}] both ${activeId} and ${secondaryId} failed; falling back to chained modelJson. ${error instanceof Error ? error.message : String(error)}`
      );
      return modelJson(prompt, fallback, parser, systemContent);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function updateThreadSummary(input: {
    /** Contact's name — used as fallback summary text "Conversation with {name}." */
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    /** Last persisted remember items — kept as the fallback if the AI call fails. */
    previousRemember: RememberItem[];
    messages: MessageForPrompt[];
    /**
     * True when the contact's last message is newer than the operator's —
     * i.e. an active ask is pending. False when the operator already
     * replied (or the thread is fresh), in which case the summary switches
     * to "reconnect mode": what_they_want and open_loops become hooks for
     * reopening the conversation rather than items to address.
     */
    needsReply: boolean;
    /**
     * Race the call across two providers and keep the first valid
     * response (issue #382 — pilot R-0029). Only set this from
     * operator-initiated, user-visible paths (Reassess endpoint).
     * Doubles provider spend per call, so do NOT enable for scans or
     * background AI without a separate cost conversation.
     */
    race?: boolean;
  }): Promise<SummaryOutput> {
    const lastInbound = [...input.messages].reverse().find((msg) => msg.direction === "IN");
    const lastMessage = input.messages[input.messages.length - 1];

    const fallbackWhatTheyWant = lastInbound ? capAskSummary(lastInbound.text) : "No clear ask yet.";
    const fallbackNeedsReply = lastMessage?.direction === "IN";
    const fallback: SummaryOutput = {
      summary: input.previousSummary ?? `Conversation with ${input.displayName}.`,
      // capAskSummary backs the fallback up to a whole word at the ask-summary
      // budget (200 code points) and drops any dangling connective, so the cut
      // never bisects a word or emoji surrogate pair and never stores a
      // trailing "...and". The Today hero renders this in full via <FitText>,
      // shrinking the font rather than clipping (issue #193).
      what_they_want: fallbackWhatTheyWant,
      open_loops: input.previousOpenLoops,
      remember: input.previousRemember,
      tone_notes: [],
      needs_reply: fallbackNeedsReply,
      urgency_hint: undefined,
      // When the AI call fails entirely we still need a brief so the right
      // rail can render. Synthesise it from the legacy fallback fields —
      // conservative by design (no invented obligations).
      reply_brief: synthesiseFallbackBrief({
        rollingSummary: input.previousSummary ?? `Conversation with ${input.displayName}.`,
        whatTheyWant: fallbackWhatTheyWant,
        openLoops: input.previousOpenLoops,
        needsReply: fallbackNeedsReply,
        latestInboundText: lastInbound?.text ?? null
      })
    };

    // Issue #685: the reassess prompt names the operator so the contact's
    // habit of addressing them by name in third person ("<name> come back")
    // resolves to "you" instead of reading as a third party. Read directly
    // from settings rather than threading through every caller; a failed
    // settings read must never sink a summary, so fall back to the generic
    // (nameless) resolution rule.
    const operatorDisplayName = await settingsStore
      .getOperatorProfile()
      .then((profile) => profile.displayName)
      .catch(() => "");

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
    const contactLabel = contactTranscriptLabel(input.displayName);
    // buildReassessTranscript inserts the LIVE_EXCHANGE_MARKER at the start of
    // the recent exchange (when there is older background above it), giving the
    // brief an unambiguous recency cutoff. Paired with BRIEF_RECENCY_DISCIPLINE
    // in the prompt below so a months-old one-off beat can't surface as live
    // reply debt. Short threads render exactly as before.
    const transcript = buildReassessTranscript(input.messages, contactLabel);

    // Summaries refer to the operator in second person ("you") regardless
    // of whether they've configured a displayName. The transcript label
    // stays `operator:` for attribution discipline, but output text uses
    // "you" so the reader sees natural prose like "Ashley let you know…"
    // (issue #340 originally introduced a displayName-based name; we
    // walked that back — the name in the sidebar greeting is enough,
    // summaries read better in second person).

    // Mode is decided by the MODEL based on whether the recent exchange
    // has unaddressed contact substance, NOT by the operator-vs-contact
    // timestamp alone. Pilot R-0028 (#380) flagged the bug: when the
    // contact sent five messages and the operator only replied to one,
    // lastOutbound > lastInbound flipped needsReply to false and the
    // prompt switched to reconnect framing — even though four topics
    // were still open. The fix: pass the timestamp signal as CONTEXT,
    // ask the model to evaluate substance, and gate reconnect framing
    // behind "no remaining reply-worthy contact points".
    const modeBlock = `TIMESTAMP SIGNAL (context only, NOT a verdict):
- The operator has ${input.needsReply ? "NOT yet replied" : "ALREADY replied"} since the contact's most recent message.
- IMPORTANT: this is a context signal only. It does NOT prove the operator addressed everything. A single inbound from the contact often carries multiple distinct beats (a question + an update + a piece of news + a follow-up ask). The operator may have covered some and left others open. Read the recent exchange and decide what reply debt actually remains — DO NOT use the timestamp signal alone to decide mode.

MODE DECISION (made by you, the model, after reading the transcript):
- ACTIVE REPLY (the default for any thread where the contact has unaddressed substance) — produce a brief framed around responding to what's still open. Reply debt drives the output. Use this even when lastOutbound > lastInbound if the operator's last reply only partially covered the contact's recent points.
- RECONNECT (use ONLY when ALL of these hold) —
    1. Every distinct beat from the contact's recent inbound has a substantive reply from the operator (or the operator clearly declined / moved past it). A vague acknowledgement does NOT count as covering multiple distinct points.
    2. The last meaningful exchange is old enough to read as genuinely dormant (think weeks or months of silence, not hours since the operator's last reply).
    3. The operator hasn't already moved the conversation forward in their latest reply (e.g. asking a fresh question that's still hanging).
  In RECONNECT mode, what_they_want and open_loops reframe as warm callbacks the operator could send to reopen the thread.

what_they_want guidance (ACTIVE REPLY):
- 1-2 short sentences, plain prose, British English, no trailing ellipsis. Keep it tight — aim for roughly 120 characters and never exceed 200. It MUST be a COMPLETE, self-contained thought: finish the sentence, and never trail off on a dangling word or connective (do not end on "and", "to", "with", "gently", or "...the update and gently"). If the whole thought will not fit, write a SHORTER sentence that still resolves — never a half-finished one.
- Recap what the last 2-3 messages have actually said — name the topic and what the contact is waiting on the operator to do or answer next.
- Ground in real content from the recent messages. Do not paraphrase into vague abstractions ("a quick coordination on location") when the messages have specifics ("asked if you've watched the MJ movie; he's deciding whether to go with Timi"). If you can't ground it in named content, fall back to literally quoting the gist.
- Examples: "Sultan asked if you've watched the MJ movie, he's deciding whether to go with Timi.", "Carlos confirmed Friday lunch, he's waiting on you to pick a time.", "She shared photos from Lagos and asked when you're free for dinner."

open_loops guidance (ACTIVE REPLY):
- Work through the recent inbound messages ONE AT A TIME. For each unanswered inbound message, pull out every distinct thing the operator still needs to respond to: a question, a request, a decision they were asked to weigh in on, a piece of news that deserves a reaction. A single message often holds two or three separate loops — surface each one, never collapse a multi-part message into one vague loop.
- Focus on what is still LIVE. The most recent 2-3 inbound messages define the active topic.
- PARTIAL-COVER RULE (the #380 regression). When the operator's last reply only addressed SOME of the contact's recent points, the rest STAY OPEN. Do NOT mark them handled just because the operator typed something afterwards. Contact sent four topics, operator covered one → three are still required_points. A vague "thanks" or "fairs" from the operator does not cover multiple distinct contact points.
- DROP any older loops where the conversation has clearly moved on to an unrelated topic. If the recent exchange is about a movie and the old loops are about a months-old logistics request, do not surface those — they're stale.
- EXCLUDE any loop where the operator (or the contact themselves) already answered or substantively addressed it later in the same transcript.
- A loop is still open if it was acknowledged ("yeah good question") but never actually answered.
- Be specific and grounded in the message. "Tell her which day works for the call" beats "Reply about scheduling" — name the actual thing the contact raised.
- 0-6 loops. Cover every genuinely open point, but do not pad with things already handled. Quality and completeness over volume.
- Phrase each as a short follow-up prompt: "Send the doc they asked about" / "Pick up the thread about their move to Lagos".

what_they_want guidance (RECONNECT — only when the three criteria above all hold):
- 1-2 short sentences, plain prose, British English, no trailing ellipsis. Keep it tight — aim for roughly 120 characters and never exceed 200. It MUST be a COMPLETE, self-contained thought: finish the sentence, and never trail off on a dangling word or connective (do not end on "and", "to", "with", "gently", or "...the update and gently"). If the whole thought will not fit, write a SHORTER sentence that still resolves — never a half-finished one.
- Frame as: "what's the warmest, most natural way for the operator to reopen this thread, grounded in something specific the contact has shared." Reference a real detail from the transcript — something they mentioned doing, a thing they were working through, a small life update.
- Do NOT phrase as a task the operator owes. This is reconnect mode — the operator is choosing to reach out, not responding to a pending ask.
- Examples: "Sultan mentioned exam stress last month, a 'how'd they go?' check-in is natural.", "She was deciding between two job offers, worth asking how that landed.", "He said he'd send the doc but went quiet, a light nudge would land well."

open_loops guidance (RECONNECT):
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
  "remember": [{ "note": "string", "date": "YYYY-MM-DD or null" }, ...],
  "tone_notes": ["string", ...],
  "needs_reply": true | false,
  "urgency_hint": "string or omit if none",
  "reply_brief": {
    "where_it_stands": "string — see Reply Brief guidance below",
    "they_said": [{ "id": "short-slug", "text": "one substance bullet from the latest unanswered inbound" }, ...],
    "on_you": "string — the obligation read",
    "required_points": [{ "id": "short-slug", "text": "specific thing on the operator", "status": "required" }, ...],
    "optional_followups": [{ "id": "short-slug", "text": "nice-to-have move you suggest", "status": "optional" }, ...],
    "handled_points": [{ "id": "short-slug", "text": "thing that no longer needs action", "status": "handled", "reason": "the actual answer/substance, not just 'topic moved on'" }, ...],
    "fuller_context": "string or null — longer chain context for the More disclosure",
    "durable_context": "string or null — who they are / how the operator knows them",
    "tone_steer": "string or null — one short line on how to approach the reply",
    "enough_to_reply_without_scrolling": true | false
  }
}

${currentTimeContext()}

Reminder: lines starting with \`operator:\` are the operator's own words; the contact's own lines are prefixed with their name (or \`contact:\` when no name is known). Never paraphrase one as if it were the other, and never treat a name mentioned inside a message body as the contact's name.

${SECOND_PERSON_RESOLUTION}

${operatorNameResolution(operatorDisplayName)}

OPERATOR OUTPUT VOICE: Write user-facing strings (summary, what_they_want, open_loops, remember notes, tone_notes, urgency_hint) in SECOND PERSON. Refer to the operator as "you" (e.g. "Ashley is waiting on you to reply"). NEVER write the literal phrases "the operator" or "operator" in output text — those words exist only as the transcript attribution label.

${modeBlock}

REPLY BRIEF guidance (both modes). The reply_brief drives the thread right rail. It must let the operator write a thoughtful reply WITHOUT scrolling up into the message history. The default visible card surfaces where_it_stands → they_said → on_you in that order, so structure the brief as: context (what was asked / what's the topic), substance (what the contact actually said), obligation (what's on the operator). The substance is the part operators consistently say is too compressed — do not over-summarise it.

${BRIEF_RECENCY_DISCIPLINE}

${BRIEF_FIDELITY_REMINDER}

${BANTER_DISCIPLINE}

${contactNameContext(input.displayName)}

where_it_stands (CONTEXT ONLY — KEEP TIGHT):
- 1-2 short sentences. Plain British English. ≤ 280 chars total.
- Open with what the OPERATOR last asked or last shared on the active topic, in second person. Examples: "You asked Brandon whether he'd started exploring executive search opportunities, or was still figuring out his next steps.", "You sent the slides and asked what she thought.", "You haven't asked anything yet — Marianne sent a thread of updates."
- If the operator has not asked anything specific in the recent exchange, describe what the contact has now opened with — one sentence, neutral. Example: "Brandon has sent through a long update on where he's landed since you last spoke."
- DO NOT cram the contact's reply substance into where_it_stands. The substance goes in they_said. This field is just the setup.
- No abstract coaching ("deepen the connection", "grounded question", "helpful nudge"). No marketing register.
- DO NOT attribute operator words to the contact, or vice versa. The transcript speaker labels (\`operator:\` and the contact's own name) are authoritative — a name appearing INSIDE a message body is a third party being discussed, not the speaker, and never the contact's own name.

they_said (SUBSTANCE — the most important field):
- A bulleted list of every reply-relevant detail from the LATEST UNANSWERED INBOUND from the contact — that inbound sits below the LIVE EXCHANGE marker. NEVER pull substance from the older background above the marker, even if it reads as more interesting; a beat from weeks or months ago is not what the operator is replying to now.
- The test for each bullet: "would the operator need this detail to write a thoughtful reply?" If yes, include it.
- Capture each of these when present in the inbound: direct answers to the operator's question(s), decisions, constraints, reasons / explanations, news, updates, plans, anything implying emotional weight or significance, and follow-up opportunities the contact opened.
- One detail per bullet — do NOT merge ("recruiters pitch your CV and he has interviews and one offer" must split into three bullets). The whole point is to lay the substance out so the operator can scan it.
- Each bullet is plain prose, one short sentence (≤ 200 chars), grounded in real words from the inbound. Use third person ("He explained that...", "She mentioned...", "They said..."). Quote concrete details ("paused the offer because the clients are based in the Middle East"), never abstractions.
- 0-6 bullets. Match the texture of the inbound: a multi-part answer needs 3-5 bullets, a short message needs 1-2 or even none. Do NOT pad with invented detail to hit a number.
- Empty array [] when there is no recent unanswered inbound (reconnect mode), when the latest inbound is a bare acknowledgement ("thanks", "👍"), or when the inbound is genuinely thin.
- NEVER include the operator's words here. NEVER include reply tasks here — those belong in required_points.

on_you (THE OBLIGATION READ):
- Plainly state whether the contact has actually asked the operator for anything.
- If the contact has NOT asked anything explicit, say so directly. Example wording: "Nothing asked — a light acknowledgement is enough."
- If the contact has asked ONE thing, name it. Example: "She asked whether Friday works."
- If the contact has asked MULTIPLE things, list them tightly. Example: "She asked for the document, your availability, and whether you can invite Tolu."
- For a message that's a multi-part personal update (decisions, constraints, news) without explicit asks, point at the single beat that most calls for acknowledgement — but state it in the contact's own terms. Name the fact, do NOT characterise it as "big", "weighty", "main", "huge", or "the thing". Example (grounded): "He's paused a job offer because the clients were based in the Middle East. A short acknowledgement is enough." NOT: "He paused the offer — that's the big thing worth acknowledging" (you invented "big thing").
- Never invent obligations. If the contact is simply updating the operator, say a light social reply is enough.
- ONE sentence, ~140 characters max. The on_you block is the obligation read, not a paragraph. Resist stacking guidance ("acknowledge X; follow up on Y; keep the door open") — that pattern reliably blows past the budget and the dashboard truncates it mid-word. Pick the single most important obligation. Anything else goes in required_points or optional_followups.

required_points (status = "required") — the reply checklist:
- BE CONSERVATIVE. Required points are the small set of things the operator MUST address. If a point is borderline, send it to optional_followups instead — the rail's job is to prevent invented homework, not to manufacture it. The substance the operator should read is already in they_said; required is only for "you owe a response on this".
- Always belongs in required: direct questions to the operator, requests, decisions the contact asked the operator to make, things asked to send / confirm / check / arrange. A question the operator acknowledged but never actually answered counts as required.
- Acknowledgement-worthy news: when the contact has NOT asked anything explicit but has shared a single substantive beat the operator would feel rude ignoring (a paused offer, a decision they made, a life event they named), surface AT MOST ONE required point. Phrase the point in grounded terms naming the beat in the contact's own words ("Acknowledge the paused offer", "Acknowledge the move to Lagos") — do NOT characterise the beat itself ("Acknowledge the big news", "Acknowledge the major decision"). Any further acknowledgements go in optional_followups. The high bar is: "would the contact feel actively unheard, not just under-engaged, if the reply ignored this?" A piece of explanation or background context they shared does NOT meet that bar — that's substance for they_said to surface, not a task.
- For a multi-part inbound where the contact DID ask several distinct things, surface each ask as its own required point. Asks > acknowledgements.
- "Ask how X is going" / "ask about Y" prompts are NEVER required — the contact did not ask the operator to ask back. They go in optional_followups.
- Each text is a short follow-up prompt the operator can act on. Start with a verb. Examples: "Acknowledge the paused offer", "Send the deck Marianne asked about", "Confirm Friday at 11 works".
- Volume guide:
    - Thread with no explicit ask: 0-1 required points. Default to 0 when in doubt.
    - Thread with one ask: 1-2.
    - Thread with multiple asks: up to 4.
    - Above 4 only when the contact is genuinely waiting on several distinct deliverables. Never pad to hit a number.
- NEVER include relationship-deepening moves, curiosity prompts, or "ask back" follow-ups here.

optional_followups (status = "optional"):
- Nice-to-have conversational moves the AI suggests, that the contact did NOT actually ask for.
- Warm callbacks, curiosity prompts, relationship-deepening follow-ups, "ask what they're working on now".
- 0-4 points. Skip entirely when there's nothing genuinely interesting to add.
- These NEVER appear in required_points. They never gate sending.

handled_points (status = "handled"):
- Things that no longer need action. Drop from required_points but record here so the operator can see why something is no longer flagged.
- Questions the contact answered themselves later in the transcript.
- Questions the operator already answered later in the transcript.
- Older topics where the conversation clearly moved on to something else.
- Rhetorical questions.
- Stale requests that would feel awkward to resurrect unless the operator explicitly chooses to.
- The "reason" field MUST carry the actual answer / substance in compact form, not just "topic moved on" or "you covered this". The operator should be able to read the reason and know what was settled without scrolling back. Examples: "she answered Friday at 11 works herself two messages later", "you replied that Tuesday won't work because of the school run", "he said the deck looked great and moved on to ask about the trip dates". Lowercase fine, ≤ 160 chars.
- 0-6 points. Omit the field entirely if nothing was dropped.

fuller_context:
- Optional longer trace for the expanded "More" disclosure. Used when the conversation has texture worth unpacking (a longer arc, a shift in topic, a relevant earlier exchange).
- Plain prose, 1-3 sentences. Null when where_it_stands already covers everything.

durable_context:
- Optional one-line "who they are / how the operator knows them" — what would help if the operator hadn't spoken to this person in months. Null when unknown.

tone_steer:
- Optional one short line on how to approach the reply ("warm and brief, matches her tone", "stay direct — he's busy"). Null when nothing specific is worth saying.

enough_to_reply_without_scrolling:
- Boolean self-check: would the where_it_stands + on_you blocks let the operator write a reply WITHOUT having to scroll back into the message history? Be honest; this is a signal, not a gate.

GLOBAL Reply Brief rules:
- Use plain, direct British English in every brief field.
- Do NOT use the phrases "deepen the connection", "grounded question", "helpful nudge", "agile career planning", "build rapport", "deepen rapport" anywhere in default-visible sections.
- Keep total brief length tight enough to scan in under 10 seconds.
- Required and optional and handled are MUTUALLY EXCLUSIVE buckets. A single point cannot appear in more than one.
- they_said is the substance the contact shared; required_points is the action verbs the operator should take in response. The same beat can appear once in each (e.g. they_said: "He said he paused the offer because the clients are based in the Middle East." paired with required_points: "Acknowledge the paused offer"). That pairing is correct — they_said carries the substance, required_points carries the action.
- In RECONNECT mode the contact is not waiting on the operator and there is no fresh inbound to unpack — set they_said to an empty array [] in that case. Do NOT mine old messages for substance bullets when the operator already replied.

remember guidance (both modes):
- Separately from the loops above, extract durable facts worth remembering about the contact's life: exams, trips, interviews, job or house moves, health things, family events, birthdays, milestones, deadlines they mentioned.
- These are NOT reply tasks and NOT the current conversation topic — they are things the operator would want to keep in mind weeks from now.
- Each item is { "note": short third-person phrase, "date": "YYYY-MM-DD" or null }.
- "note" examples: "Final exams", "Trip to Lagos", "Job interview at Spotify", "Starts new role", "Sister's wedding". A few words, no tasks, no questions.
- Set "date" ONLY when the transcript states or clearly implies a specific calendar date. Resolve relative dates ("next Friday", "the 30th", "in two weeks") against the message timestamp into an absolute YYYY-MM-DD. If no specific date is recoverable (they just said "I have exams soon"), set "date" to null. NEVER guess or invent a date.
- DROP anything whose date has clearly already passed. DROP one-off small talk.
- 0-5 items. Only genuinely durable facts.

General rules (both modes):
- One loop per item. Don't merge ("their work + their move + their dog") into a single string.
- Phrase loops as actions the operator can take, never as the contact's quoted question.
- The "summary" field stays stable — it's the durable relationship description, not the mode-specific recap. Update it only when the relationship itself shifts (new shared context, role change, etc.).

Previous summary: ${input.previousSummary ?? "None"}
Previous open loops: ${JSON.stringify(input.previousOpenLoops)}
Previous remember items: ${JSON.stringify(input.previousRemember)}
Transcript:
${transcript}`;

    // Issue #382. When `race` is set, dispatch the call against the
    // active provider and one pinned secondary in parallel and keep
    // the first response that comes back with a real provider source
    // (not the caller-supplied fallback). On both-fail or no second
    // provider configured, walk the normal chained modelJson path so
    // the call is purely additive — the worst case is identical to
    // today.
    const parseSummary = (value: unknown) => summarySchema.parse(value);
    const { result, source } = input.race
      ? await raceModelJson(prompt, fallback, parseSummary, undefined, "reassess-summary")
      : await modelJson(prompt, fallback, parseSummary);
    // Safety net. The prompt asks for a complete, self-contained ask within
    // ~200 chars; this guards a runaway multi-sentence response. capAskSummary
    // backs up to a whole word at the 200-char budget AND drops a trailing
    // dangling connective, so an over-long ask ends cleanly ("...come along")
    // rather than mid-word ("...skills fo") or on a connective ("...and").
    // A complete ask (the norm) is well under the budget and passes through
    // untouched, so the cap can no longer amputate a full thought (the old
    // 120-char cut that stored "...acknowledge the update and gently"). The
    // Today hero renders the result in full via <FitText> (issue #193).
    result.what_they_want = capAskSummary(result.what_they_want);
    // Sanitise remember items: strip unpaired surrogates from notes (the
    // same SQLite-write hazard the summary fields guard against), coerce
    // dates to strict ISO-or-null, and drop anything left without a note.
    result.remember = result.remember
      .map((item) => ({
        note: stripUnpairedSurrogates(item.note).trim(),
        date: normalizeRememberDate(item.date)
      }))
      .filter((item) => item.note.length > 0);

    // Reply Brief post-processing. The zod schema accepts the brief as
    // `unknown` so a malformed shape doesn't reject the entire summary.
    // sanitizeReplyBrief enforces the classification invariants (required
    // / optional / handled mutually exclusive, banned coaching phrases
    // stripped, caps applied). When the model omits the brief entirely,
    // synthesise one from the legacy fields so the rail still renders.
    const sanitisedBrief = sanitizeReplyBrief(result.reply_brief);
    const finalBrief: ReplyBrief =
      sanitisedBrief ??
      synthesiseFallbackBrief({
        rollingSummary: result.summary,
        whatTheyWant: result.what_they_want,
        openLoops: result.open_loops,
        needsReply: result.needs_reply,
        latestInboundText: lastInbound?.text ?? null
      });

    // Mirror required_points.text into open_loops so the legacy checklist,
    // the /check-draft loop matcher, and the inbox preview stay in lockstep
    // with the brief. The brief is authoritative; we never want open_loops
    // to surface a loop the brief doesn't classify as required.
    const mirroredLoops = mirrorRequiredToOpenLoops(finalBrief);
    const finalOpenLoops = mirroredLoops
      ? mirroredLoops.map((loop) => stripUnpairedSurrogates(loop))
      : result.open_loops;

    // Build the typed SummaryOutput explicitly — `result.reply_brief` is
    // `unknown` per the permissive zod schema, so we cannot just return
    // `result` directly without a type clash against SummaryOutput.
    // User-facing summary fields share the brief's scrub: strip banned
    // coaching phrases + em/en dashes (the hard UI-copy rule) before they
    // render into the Today hero, thread rail, and inbox preview. Mirrors
    // what reply_brief fields already get via sanitizeReplyBrief.
    const output: SummaryOutput = {
      summary: stripBannedPhrases(result.summary),
      what_they_want: capAskSummary(stripBannedPhrases(result.what_they_want)),
      open_loops: finalOpenLoops.map((loop) => stripBannedPhrases(loop)).filter((loop) => loop.length > 0),
      remember: result.remember,
      tone_notes: result.tone_notes.map((note) => stripBannedPhrases(note)).filter((note) => note.length > 0),
      needs_reply: result.needs_reply,
      urgency_hint: result.urgency_hint,
      reply_brief: finalBrief,
      // Carry the provider source through so persisting callers can tell a
      // real summary from the synthesised fallback (source.providerId === null
      // ⇒ every provider failed). Mirrors generateSuggestedReplies, which
      // returns `source` for the same reason.
      source
    };
    return output;
  }

  async function generateSuggestedReplies(input: {
    /**
     * Contact's name. Injected into the prompt as the `Recipient: <name>`
     * line that CONTACT_NAME_DISCIPLINE treats as the authoritative contact
     * name — without it the model falls back to the discipline block's
     * example name ("Seyi") and mislabels the contact.
     */
    displayName: string;
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
    recentMessages: MessageForPrompt[];
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
    /**
     * Writing style measured from the operator's / contact's own recent
     * messages on this thread. Rendered into the prompt so suggestions
     * adapt to how each side actually writes — length, punctuation,
     * capitalisation, emoji (issue #299). Null when history is too thin.
     */
    operatorStyle?: StyleProfile | null;
    contactStyle?: StyleProfile | null;
    /**
     * The compressed reply brief from the most recent thread analysis.
     * Carries the substance bullets (they_said) and the obligation read
     * (on_you) so the suggested replies engage with each reply-relevant
     * beat from the latest inbound, not just the first surface point.
     * Null on cold paths.
     */
    replyBrief?: ReplyBrief | null;
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
    const recentExchange = renderSuggestedRepliesExchange(
      input.recentMessages,
      contactTranscriptLabel(input.displayName)
    );

    // Mode switches the whole framing. In reply mode the model produces
    // three responses to the contact's pending message. In reopen mode
    // the operator chose to reach out into a quiet thread, so the model
    // produces three conversation starters grounded in concrete details
    // from the transcript (warm callbacks, "wow you remembered" moments,
    // small things the contact mentioned that would feel good to bring
    // up). The output shape is identical so the dashboard renders both
    // the same way.
    const replyMode = selectSuggestedReplyMode({
      needsReply: input.needsReply,
      replyBrief: input.replyBrief,
      openLoops: input.openLoops
    });
    const modeBlock = replyMode === "reply"
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

    // Observed-style fragments (issue #299) — concrete length / emoji /
    // full-stop / capitalisation signals measured from real messages so
    // suggestions match how the operator and contact actually write,
    // not only the generic voice tier. Each renders to "" when there
    // isn't enough history, so the join collapses cleanly.
    const styleGuidance = [
      describeOperatorStyle(input.operatorStyle),
      describeContactStyle(input.contactStyle)
    ]
      .filter((fragment) => fragment.length > 0)
      .map((fragment) => `\n\n${fragment}`)
      .join("");

    // Reply-brief fragment. When the upstream summary run produced a brief,
    // we hand the model the substance bullets the operator will see in the
    // rail and the obligation read so the generated replies engage with
    // EVERY reply-relevant beat from the latest inbound, not just the
    // first surface point. Without this, multi-part inbound (e.g. Brandon
    // explaining recruiters AND naming interview status AND naming a
    // paused offer with a constraint) reliably produced replies that
    // acknowledged one beat and ignored the rest.
    const replyBriefFragment = (() => {
      const brief = input.replyBrief;
      if (!brief) return "";
      const substance = (brief.they_said ?? [])
        .map((p) => p.text.trim())
        .filter((t) => t.length > 0);
      if (substance.length === 0 && !brief.on_you?.trim()) return "";
      const lines: string[] = ["", "Reply brief from the latest analysis — engage with EVERY beat in 'They said' across the three replies, not just the first one. A reply that ignores a substantive beat the contact took the time to share will feel like the operator skim-read the message."];
      if (brief.where_it_stands?.trim()) {
        lines.push(`Where it stands: ${brief.where_it_stands.trim()}`);
      }
      if (substance.length > 0) {
        lines.push("They said:");
        for (const bullet of substance) lines.push(`- ${bullet}`);
      }
      if (brief.on_you?.trim()) {
        lines.push(`On you: ${brief.on_you.trim()}`);
      }
      const required = (brief.required_points ?? [])
        .map((p) => p.text.trim())
        .filter((t) => t.length > 0);
      if (required.length > 0) {
        lines.push("Worth addressing in the reply:");
        for (const bullet of required) lines.push(`- ${bullet}`);
      }
      return `\n${lines.join("\n")}\n`;
    })();

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

${PREDRAFT_FIDELITY_REMINDER}

${contactNameContext(input.displayName)}

${currentTimeContext()}

${modeBlock}${lateReplyHint}${replyBriefFragment}${operatorProfileFragment(input.operatorProfile)}${styleGuidance}${
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
    messages: MessageForPrompt[];
    summary?: string | null;
    whatTheyWant?: string | null;
    /**
     * Race the call across two providers and keep the first valid
     * classification (issue #382 — pilot R-0029). Same caveat as
     * updateThreadSummary's race option: operator-initiated paths
     * only, doubles spend per raced call.
     */
    race?: boolean;
  }): Promise<"outreach" | "genuine" | null> {
    const inboundMessages = input.messages
      .filter((m) => m.direction === "IN")
      .slice(0, 5)
      .map((m) => safeTruncate(renderMessageBody(m), 600))
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

    // One single-provider call. Returns null on any failure so the race
    // path can treat "still running but slow" and "failed silently" the
    // same way — caller already handles null.
    const callOne = async (providerId: AiProvider): Promise<"outreach" | "genuine" | null> => {
      const { client, model } = resolveProvider(providerId);
      if (!client) return null;
      try {
        const response = await client.chat.completions.create({
          model,
          ...(shouldUseJsonResponseFormat(providerId, model)
            ? { response_format: { type: "json_object" as const } }
            : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: reinforceJsonPrompt(prompt, model) }
          ],
          ...providerOptions(providerId, model),
          ...geminiExtraBody(providerId, model)
        });
        const content = response.choices[0]?.message?.content;
        if (!content) return null;
        const parsed = categorySchema.parse(parseAiJson(content, model));
        return parsed.category;
      } catch (error) {
        console.warn(
          `[ai] classifyThreadCategory failed (provider=${providerId}, model=${model}); returning null. ${classifyLlmError(error, providerId)}`
        );
        return null;
      }
    };

    const { provider: activeId } = await resolveActive();

    // Issue #382. Race two providers when the operator-initiated path
    // opts in. Falls back to a single active-provider call when no
    // secondary is configured (race has nothing to race) — purely
    // additive.
    if (input.race) {
      const secondaryId = pickRaceSecondary(activeId);
      if (secondaryId) {
        try {
          const outcome = await raceAiProviders<"outreach" | "genuine" | null>({
            primary: { providerId: activeId, call: () => callOne(activeId) },
            secondary: { providerId: secondaryId, call: () => callOne(secondaryId) },
            validate: (value) => value !== null
          });
          const loser = outcome.loser;
          const loserDescription =
            loser.kind === "still_running"
              ? `${loser.providerId}/still_running`
              : `${loser.providerId}/${loser.kind}/${Math.round(loser.durationMs)}ms`;
          console.log(
            `[ai-race reassess-classify] winner=${outcome.winnerProviderId}/${Math.round(outcome.winnerDurationMs)}ms ${loserDescription}`
          );
          return outcome.result;
        } catch (error) {
          // Both providers returned null (already logged per-provider).
          // Treat the same way the non-race path would: classification
          // unavailable, caller falls back to the existing category.
          console.warn(
            `[ai-race reassess-classify] both ${activeId} and ${secondaryId} returned null. ${error instanceof Error ? error.message : String(error)}`
          );
          return null;
        }
      }
    }

    return callOne(activeId);
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
    threadMessages: MessageForPrompt[];
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
    /** Observed writing style of the operator / contact on this thread,
     *  rendered into the prompt so the rewrite matches how each side
     *  actually writes (issue #299). Null when history is too thin. */
    operatorStyle?: StyleProfile | null;
    contactStyle?: StyleProfile | null;
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
      .map((m) => renderMessageBody(m).trim())
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
        (Number.isFinite(lastOutboundAt) && lastInboundAt < lastOutboundAt)
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
      return `\nThe operator hasn't replied in ${days} days. Open with a brief, natural acknowledgement of the gap in their register (${suggestions}) — pick whichever fits, don't dwell on it, name it once and move on.`;
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

    // Observed-style fragments (issue #299): concrete length / emoji /
    // full-stop / capitalisation signals measured from real messages, so
    // the rewrite matches how each side actually writes. Each renders to
    // "" when history is too thin, so the join collapses cleanly.
    const styleGuidance = [
      describeOperatorStyle(input.operatorStyle),
      describeContactStyle(input.contactStyle)
    ]
      .filter((fragment) => fragment.length > 0)
      .map((fragment) => `\n\n${fragment}`)
      .join("");

    const prompt = `Rewrite the operator's intent below as a complete, sendable ${platformMessageNoun(input.platform)} in the operator's voice. Match the length and energy of the recipient's last message (reciprocity rule from system prompt). When in doubt, err shorter. The voice samples below are additional calibration for this thread, the few-shot examples in the system prompt are the primary reference.

${PREDRAFT_FIDELITY_REMINDER}

${contactNameContext(input.displayName)}

${currentTimeContext()}

Operator's intent: ${safeTruncate(trimmed, 600)}

Recent voice samples (operator's own past messages on this thread, oldest first):
${cleanedSamples.length > 0 ? cleanedSamples.map((s, i) => `${i + 1}. ${safeTruncate(s, 320)}`).join("\n") : "(no prior outbound on this thread — match general British peer-to-peer warmth)"}
${recipientSamples.length > 0 ? `\nRecipient's recent messages on this thread (oldest first — match their tempo, length, and warmth, not just the last line):\n${recipientSamples.map((s, i) => `${i + 1}. ${safeTruncate(s, 320)}`).join("\n")}` : ""}
${lastInbound ? `\nLast message from recipient: ${safeTruncate(renderMessageBody(lastInbound), 400)}` : ""}${lateReplyHint}${relationshipHint}${operatorProfileFragment(input.operatorProfile)}${styleGuidance}${
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

Return strict JSON: { "suggestions": [{ "label": "string", "hours": 1-72, "reason": "string" }] }
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
      const itemSchema = z.object({
        label: z.string().min(1).max(40),
        hours: z.number().int().min(1).max(72),
        reason: z.string().min(1).max(220)
      });
      const raw = parseAiJson(content, model) as { suggestions?: unknown };
      const rawList = Array.isArray(raw?.suggestions) ? raw.suggestions : [];
      // Validate per-item and keep the valid ones. A single malformed or
      // out-of-range entry (e.g. the model returns a 96h "next week" target)
      // must not throw out the whole batch; clamp hours into [1,72] first so
      // a slightly-too-large hint is kept at the ceiling rather than dropped.
      const suggestions = rawList
        .map((entry) => {
          const candidate =
            entry && typeof entry === "object" && "hours" in entry && typeof (entry as { hours: unknown }).hours === "number"
              ? { ...(entry as Record<string, unknown>), hours: Math.min(72, Math.max(1, Math.round((entry as { hours: number }).hours))) }
              : entry;
          const result = itemSchema.safeParse(candidate);
          return result.success ? result.data : null;
        })
        .filter((entry): entry is z.infer<typeof itemSchema> => entry !== null)
        .slice(0, 3);
      return { suggestions };
    } catch (error) {
      console.warn(
        `[ai] suggestSnoozeTimings failed (provider=${provider}, model=${model}); returning empty list. ${classifyLlmError(error, provider)}`
      );
      return { suggestions: [] };
    }
  }

  /**
   * Issue #392. Parse a free-text "remind me to…" intent typed by the
   * operator into a structured {remindAtIso, reminderText} pair so the
   * thread can be snoozed until the parsed time with the reminder note
   * attached. Returns { confidence: "low" } when the time hint is
   * ambiguous or missing — caller surfaces the parse back to the
   * operator for confirmation rather than guessing.
   *
   * Examples of input:
   *   "remind me to follow up with him next Tuesday"
   *   "remind me to ask Brandon how the interviews went in 3 days"
   *   "ping me about this tomorrow morning"
   *
   * The AI's job is to:
   *   - Extract the time hint and resolve it against referenceTimeIso
   *     into an absolute ISO timestamp. Default to 9am local-ish if
   *     no time-of-day is named.
   *   - Strip the "remind me to" / "ping me about" prefix from the
   *     reminder text so the stored note reads as an action.
   *   - Refuse to invent a time when none is named — the caller
   *     handles low-confidence by asking the operator to rewrite.
   */
  async function parseReminderRequest(input: {
    intent: string;
    referenceTimeIso: string;
    displayName: string;
  }): Promise<{
    remindAtIso: string | null;
    reminderText: string;
    confidence: "high" | "low";
    reason?: string;
  }> {
    const trimmed = input.intent.trim();
    if (!trimmed) {
      return { remindAtIso: null, reminderText: "", confidence: "low", reason: "empty intent" };
    }
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return {
        remindAtIso: null,
        reminderText: trimmed,
        confidence: "low",
        reason: "AI provider unavailable"
      };
    }

    const prompt = `Parse the operator's "remind me to…" request into a structured reminder for ${input.displayName}.

Reference time (now): ${input.referenceTimeIso}

Operator's request: ${safeTruncate(trimmed, 600)}

Your job:
1. Find the time hint in the request ("next Tuesday", "in 3 days", "tomorrow morning", "later this week").
2. Resolve it against the reference time into an absolute ISO timestamp. If the operator names a date but no time-of-day, default to 09:00 local. If they say "morning" default to 09:00, "afternoon" 14:00, "evening" 18:00.
3. Extract the reminder text. Strip prefixes like "remind me to", "ping me about", "remember to". The stored note should read as an action ("Follow up on the offer", "Ask how the interviews went").
4. Set confidence = "high" when the time hint is clear and unambiguous. Set "low" when the time is missing, vague ("eventually", "soon"), or could mean multiple things ("Tuesday" without specifying which one).
5. NEVER invent a time when none is given. If confidence is "low", set remindAtIso to null and explain briefly in reason.

Return strict JSON:
{
  "remindAtIso": "ISO timestamp string, or null when confidence is low",
  "reminderText": "the action the operator wants to be reminded to do, 1 short clause",
  "confidence": "high" | "low",
  "reason": "short explanation when confidence is low; omit otherwise"
}`;

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
      if (!content) {
        return {
          remindAtIso: null,
          reminderText: trimmed,
          confidence: "low",
          reason: "empty AI response"
        };
      }
      const parsed = z
        .object({
          remindAtIso: z.string().nullable(),
          reminderText: z.string().min(1).max(240),
          confidence: z.enum(["high", "low"]),
          reason: z.string().max(240).optional()
        })
        .parse(parseAiJson(content, model));
      // Belt-and-braces: if confidence is high but remindAtIso isn't
      // a valid future ISO, demote to low rather than schedule
      // something nonsensical.
      if (parsed.confidence === "high" && parsed.remindAtIso) {
        const ms = Date.parse(parsed.remindAtIso);
        if (!Number.isFinite(ms) || ms <= Date.parse(input.referenceTimeIso)) {
          return {
            remindAtIso: null,
            reminderText: parsed.reminderText,
            confidence: "low",
            reason: "parsed time was invalid or not in the future"
          };
        }
      }
      return {
        remindAtIso: parsed.remindAtIso,
        reminderText: applyVoiceRules(parsed.reminderText),
        confidence: parsed.confidence,
        reason: parsed.reason
      };
    } catch (error) {
      console.warn(
        `[ai] parseReminderRequest failed (provider=${provider}, model=${model}); returning low confidence. ${classifyLlmError(error, provider)}`
      );
      return {
        remindAtIso: null,
        reminderText: trimmed,
        confidence: "low",
        reason: "AI parse failed"
      };
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
    /** Contact's name (the person we're characterising). */
    displayName: string;
    messages: MessageForPrompt[];
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
      .map((m) => formatMessageForPrompt(m, contactTranscriptLabel(input.displayName)))
      .join("\n");

    const prompt = `Return strict JSON matching this exact shape:
{
  "how_you_know_each_other": "string — 1-2 sentences about how the operator knows this contact, inferred from the earliest messages in the transcript",
  "recent_topics": ["string", ...] — bullet list of distinct topics they've discussed in roughly the last 30 days. 3-6 items typical. Use plain noun phrases (e.g. \\"Their move to Lagos\\", \\"The book they recommended\\"). Empty array if nothing substantive in that window.",
  "inside_jokes": ["string", ...] — short list of recurring references, running jokes, or inside threads (a recurring nickname, a private bit, a callback that reappears across messages). Empty array if there aren't any clear ones - do not invent.",
  "vibe": "string — 1-2 sentences on the tone and feel of the relationship as it shows up in this transcript. Honest, not flattering."
}

Reminder: lines starting with \`operator:\` are the operator's own words; the contact's own lines are prefixed with their name (or \`contact:\` when no name is known). Never paraphrase one as if it were the other, and never treat a name mentioned inside a message body as the contact's name.

OPERATOR OUTPUT VOICE: Write user-facing strings (how_you_know_each_other, recent_topics, inside_jokes, vibe) in SECOND PERSON — refer to the operator as "you" (e.g. "You met Ashley at university."). NEVER write "the operator" or "operator" in output text.

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
    /** Contact's name (the person being asked about). */
    displayName: string;
    question: string;
    messages: MessageForPrompt[];
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
            .map((m) => formatMessageForPrompt(m, contactTranscriptLabel(input.displayName)))
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
- Lines prefixed \`operator:\` are the operator's own words; the contact's own lines are prefixed with their name (or \`contact:\` when no name is known). Never paraphrase one as if it were the other, and never treat a name mentioned inside a message body as the contact's name.
- Write the answer in SECOND PERSON — refer to the operator as "you". NEVER write "the operator" or "operator" in the answer text; that label only exists for transcript attribution.
- Do not fabricate names, dates, jobs, locations, or any facts not in the context.

${currentTimeContext()}

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

  // Issue #438 (pilot R-0059). Infer the operator's reply-style fields from a
  // sample of their own sent messages. The sample is selected upstream; here
  // we just build the prompt, parse + normalise the model JSON, and report
  // whether a provider actually ran (so the caller can distinguish an AI
  // outage from a genuinely empty/low-confidence read). Never saves.
  async function inferReplyStyle(input: {
    sampleTexts: string[];
  }): Promise<{ suggestion: InferredReplyStyle; aiRan: boolean }> {
    const fallback = emptyInferredStyle();
    if (input.sampleTexts.length === 0) {
      return { suggestion: fallback, aiRan: false };
    }
    const prompt = buildReplyStyleAnalysisPrompt(input.sampleTexts);
    const { result, source } = await modelJson(prompt, fallback, (value) =>
      normaliseInferredStyle(replyStyleAnalysisSchema.parse(value))
    );
    return { suggestion: result, aiRan: source?.providerId != null };
  }

  /**
   * "Help me phrase this" (Focus setup sheet). The operator describes what
   * they're about to do in their own words; this turns it into the two
   * focus-note tiers in their voice. Both notes keep [Name] and [until] as
   * literal tokens — the parser REJECTS a response that drops them (the
   * provider chain then retries elsewhere), because a note with a baked-in
   * name or time would go stale or mis-personalise at send time. Returns
   * null when no provider produced a usable result. Composes only — the
   * sheet shows the result for editing, and nothing ever auto-sends.
   */
  async function composeFocusNote(input: {
    activity: string;
    operatorProfile: OperatorProfile | null;
    voiceSampleTexts: string[];
  }): Promise<ComposedFocusNote | null> {
    const activity = input.activity.trim();
    if (!activity) return null;

    const samples = input.voiceSampleTexts
      .map((sample) => sample.trim())
      .filter((sample) => sample.length > 0)
      .slice(-8);

    // Local wall-clock so "till 9" resolves to the NEXT 9 o'clock rather
    // than a coin flip between 09:00 and 21:00.
    const now = new Date();
    const nowLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const systemContent = [
      "You are helping the operator of a personal relationship inbox write a short \"I'm heads-down\" note in their OWN voice. They are about to protect a block of time (gym, driving, a lecture, deep work) and want anyone who messages meanwhile to get a quick human acknowledgement: seen you, proper reply after.",
      "",
      "Strict output rules:",
      "- Return strict JSON only.",
      "- Write TWO variants: \"close\" (casual register, friends and family) and \"professional\" (calmer, work contacts). Both in the operator's own voice, guided by the voice profile and samples in the user message. The two variants must differ in register, not just punctuation.",
      "- Each note MUST contain the literal token [Name] (where the recipient's first name will go) and the literal token [until] (where the end time will go). Never replace these tokens with a real name or a real clock time, and never invent other bracketed tokens.",
      "- Place the tokens where they read naturally: the note must stay a grammatical sentence when [Name] is swapped for a first name like Sam and [until] for a time like 7:30pm. Never tack tokens onto the end.",
      "- Never write a literal clock time anywhere in the note text — the [until] token carries it.",
      "- The voice samples show HOW the operator writes (register, slang, punctuation). NEVER reuse their content: no topics, plans, names, or sentences from the samples may appear in the note.",
      "- 1-2 short sentences per note. Plain ASCII. No em dashes, no en dashes. No emoji unless the operator's samples use them.",
      "- It must read like a person dashing off a text, never an autoresponder. Banned: \"I am currently unavailable\", \"out of office\", anything corporate.",
      "- Ground the note in what the operator said they are doing. Do not invent extra plans, places, or people.",
      "- \"reason\" is REQUIRED: a 1-3 word lowercase label naming the activity, taken from the operator's description (e.g. \"driving\", \"gym\", \"revision\", \"family time\"). Never leave it empty, never name an activity they did not mention.",
      "- \"untilTime\": ONLY when the operator states an explicit clock end time (\"till 9\", \"until 6:30pm\"), return it as 24-hour \"HH:MM\". Resolve a bare hour to the NEXT time it occurs after the current time given in the user message: at 19:40, \"till 9\" means 21:00 today; at 23:10, \"till 9\" means 09:00 tomorrow. For durations (\"for 2 hours\") or no stated time, return null — never guess.",
      "",
      "Worked example (format only — never copy its wording):",
      "Operator said: \"driving back from London till 9\" (current time 19:40)",
      "{\"close\": \"Yo [Name], driving back from London till [until], I'll reply properly after\", \"professional\": \"Hi [Name], I'm on the road till [until], I'll come back to this properly after.\", \"reason\": \"driving\", \"untilTime\": \"21:00\"}"
    ].join("\n");

    const prompt = `The operator is about to start a focus window and described it, in their words, as:
"${safeTruncate(activity, 400)}"

It is currently ${nowLabel} (24-hour clock) for the operator.${operatorProfileFragment(input.operatorProfile)}

Recent messages the operator sent (their real voice, oldest first):
${samples.length > 0 ? samples.map((s, i) => `${i + 1}. ${safeTruncate(s, 240)}`).join("\n") : "(no samples available — write plain, warm, peer-to-peer British English)"}

Return strict JSON: { "close": "string", "professional": "string", "reason": "string", "untilTime": "HH:MM or null" }`;

    const { result, source } = await modelJson<ComposedFocusNote | null>(
      prompt,
      null,
      parseComposedFocusNote,
      systemContent
    );
    return source?.providerId != null ? result : null;
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
    messages: MessageForPrompt[];
    summary?: string | null;
  }): Promise<{ status: "closed" | "open"; reason: string } | null> {
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
        text: safeTruncate(renderMessageBody(m), 600)
      }))
      .filter((m) => m.text.trim().length > 0);

    if (recentTurns.length === 0) {
      return null;
    }

    // No inbound at all means the operator was last to speak; the
    // thread is by definition waiting on them and the LLM call is
    // skipped to save tokens. The dashboard already treats OUT-direction
    // as "not closed" through the heuristic too. Use a deterministic
    // reason caption so we still get a visible "why" without paying
    // for a model call.
    const hasInbound = recentTurns.some((t) => t.direction === "IN");
    if (!hasInbound) {
      return { status: "open", reason: "you were last to speak; waiting on them" };
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
      return {
        status: parsed.status,
        // Apply the same voice rules as other rendered AI strings - the
        // post-processor scrubs em dashes, semicolons, colons that the
        // model occasionally slips in.
        reason: applyVoiceRules(parsed.reason).trim()
      };
    } catch (error) {
      console.warn(
        `[ai] classifyThreadClosed failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  /**
   * Reconnect-worthy scorer (#287 phase 3.5). Returns a 0-100 integer
   * plus a one-sentence reason for how worth it would feel for the
   * operator to send a deliberate reconnect message to this LinkedIn
   * dormant contact today. Returns null when the AI provider was
   * unavailable; the dashboard then ranks dormants by deterministic
   * relationship signals alone (outbound count, depth, recency).
   */
  async function scoreReconnectCandidate(input: {
    displayName: string;
    /** Headline / current role line, or null when no enrichment exists. */
    contactBlurb?: string | null;
    daysDormant: number;
    operatorOutboundCount: number;
    totalMessageCount: number;
    /** Oldest-first; up to 4 most recent turns is plenty for the model. */
    messages: MessageForPrompt[];
    summary?: string | null;
  }): Promise<{ score: number; reason: string } | null> {
    const { client, model, provider } = await resolveActive();
    if (!client) {
      return null;
    }

    const recentTurns = input.messages
      .slice(-4)
      .map((m) => ({ direction: m.direction, text: safeTruncate(renderMessageBody(m), 500) }))
      .filter((m) => m.text.trim().length > 0);

    if (recentTurns.length === 0) {
      return null;
    }

    const blurbLine = input.contactBlurb?.trim()
      ? `Contact blurb: ${safeTruncate(input.contactBlurb, 400)}`
      : "Contact blurb: (none)";
    const summaryLine = input.summary?.trim()
      ? `Summary so far: ${safeTruncate(input.summary, 600)}`
      : "Summary so far: (none)";

    const prompt = `${RECONNECT_SCORE_PROMPT}

Person name: ${input.displayName}
${blurbLine}
${summaryLine}
Days dormant: ${input.daysDormant}
Operator outbound count: ${input.operatorOutboundCount}
Total message count: ${input.totalMessageCount}
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
      const parsed = reconnectScoreSchema.parse(parseAiJson(content, model));
      return {
        score: parsed.score,
        // Apply voice rules so the reason caption respects the same
        // punctuation rules as the rest of the dashboard's AI strings.
        reason: applyVoiceRules(parsed.reason).trim()
      };
    } catch (error) {
      console.warn(
        `[ai] scoreReconnectCandidate failed (provider=${provider}, model=${model}); returning null. ${classifyLlmError(error, provider)}`
      );
      return null;
    }
  }

  // Issue #331. Reads the operator's in-flight draft against the active
  // open loops and returns per-loop verdicts ("addressed" or "partial").
  // The dashboard auto-ticks "addressed" rows and renders a soft "partly
  // covered" hint under "partial" rows so the operator can see why a row
  // didn't tick. Conservative by design: anything short of a substantive
  // answer is either marked "partial" (mentioned but not answered) or
  // omitted entirely (the row stays silent). Returns an empty items
  // array on failure so the UI never wedges on an error path.
  async function checkDraftCoverage(input: {
    displayName: string;
    draft: string;
    openLoops: string[];
    /** Last few turns oldest-first for context (lets the model judge whether
     *  a short ack like "yes" actually addresses the specific loop). */
    recentMessages: MessageForPrompt[];
  }): Promise<{ items: Array<{ loop: string; status: "addressed" | "partial"; reason?: string }> }> {
    if (input.openLoops.length === 0 || !input.draft.trim()) {
      return { items: [] };
    }

    const { client, model, provider } = await resolveActive();
    if (!client) {
      return { items: [] };
    }

    const recentTurns = input.recentMessages
      .slice(-4)
      .map((m) => {
        const speaker = m.direction === "OUT" ? "operator" : "contact";
        return `${speaker}: ${safeTruncate(renderMessageBody(m), 400)}`;
      })
      .join("\n");

    const loopsBlock = input.openLoops
      .map((loop, i) => `${i + 1}. ${loop}`)
      .join("\n");

    const prompt = `The operator is writing a reply to ${input.displayName}. Judge how well the DRAFT covers each LOOP below.

Each loop falls into one of three buckets:
- ADDRESSED: the draft genuinely responds to it — answers the question, makes the decision, acknowledges the news, or confirms the action.
- PARTIAL: the draft mentions or touches the loop but does NOT actually answer it. e.g. acknowledges the trip without naming dates, names the date without saying yes/no, mentions the question without resolving it.
- (omitted): the draft says nothing on this loop. Do not include these in the output.

${DRAFT_COVERAGE_GROUNDING_CLAUSE}

Return strict JSON matching this exact shape:
{
  "items": [
    { "loop": "exact loop string", "status": "addressed" }
    , { "loop": "exact loop string", "status": "partial", "reason": "one short clause naming what's still missing" }
  ]
}

Rules:
- "loop" MUST be the loop string COPIED VERBATIM from the list below. Do not paraphrase, shorten, or invent new strings. Anything that doesn't match a loop verbatim is ignored.
- "reason" is required for "partial" and must be a single short clause (under 120 chars) naming what's still missing. e.g. "doesn't name a date", "mentions the offer but doesn't say yes or no". No greetings, no preamble, no second sentence.
- Omit loops the draft doesn't touch at all. Empty items array is fine.
- When in doubt between addressed and partial, pick partial.

Recent conversation (oldest first):
${recentTurns || "(no prior messages)"}

LOOPS:
${loopsBlock}

DRAFT:
${safeTruncate(input.draft, 2000)}`;

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
      if (!content) return { items: [] };
      const parsed = draftCoverageSchema.parse(parseAiJson(content, model));
      // Keep only items whose loop matches the input verbatim. The prompt
      // asks for copies, but models occasionally paraphrase; dropping
      // mismatches stops the dashboard from trying to render a row that
      // doesn't exist in its local state. Also drop "partial" without a
      // reason — the whole point of the partial signal is the why. The
      // reason is then sanitised: dashes stripped, banned guilt phrasing
      // replaced with a static fallback, length capped at 120 chars per
      // the pilot feedback brief (R-0023). Without this the model can
      // slip a stray em-dash or a "you forgot" past the system prompt.
      const loopSet = new Set(input.openLoops);
      const seen = new Set<string>();
      const items = parsed.items
        .filter((item) => loopSet.has(item.loop))
        .filter((item) => item.status !== "partial" || (item.reason && item.reason.trim().length > 0))
        .filter((item) => {
          if (seen.has(item.loop)) return false;
          seen.add(item.loop);
          return true;
        })
        .map((item) => ({
          loop: item.loop,
          status: item.status,
          reason: item.status === "partial" ? sanitisePartialReason(item.reason) : undefined
        }));
      return { items };
    } catch (error) {
      console.warn(
        `[ai] checkDraftCoverage failed (provider=${provider}, model=${model}); returning empty. ${classifyLlmError(error, provider)}`
      );
      return { items: [] };
    }
  }

  return {
    updateThreadSummary,
    generateSuggestedReplies,
    transformReply,
    classifyThreadCategory,
    classifyThreadClosed,
    scoreReconnectCandidate,
    generateContactSummary,
    generateConversationStarters,
    composeInVoice,
    suggestSnoozeTimings,
    parseReminderRequest,
    summarisePersonForFriendship,
    askAboutPerson,
    summarisePilotReport,
    checkDraftCoverage,
    inferReplyStyle,
    composeFocusNote
  };
}
