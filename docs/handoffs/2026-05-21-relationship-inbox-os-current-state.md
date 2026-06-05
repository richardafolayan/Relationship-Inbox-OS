# Relationship Inbox OS — Current State Handoff

> Snapshot document.
> Generated on 2026-05-21 from branch `claude/objective-heyrovsky-142f3c`, equivalent to `v1/strip-back-pr1`.
> This document explains the state of the product at that point in time. It should not be treated as always current after new product/code changes.
>
> **Live operating instruction:** see [`docs/strategy/current-product-direction.md`](../strategy/current-product-direction.md). This handoff is the evidence archive; the strategy doc is the current decision.

> **Purpose.** An evidence-based snapshot of the product so a planning partner (e.g. ChatGPT) can help decide the next stage. It describes what exists, what was learnt, what is already decided, and what is still open.
>
> **How to read the evidence tags.** Throughout this report:
> - **Confirmed** — directly visible in code, schema, commits, or docs (file path cited).
> - **Inferred** — a reasonable reading of the code/docs, not explicitly stated.
> - **Unknown** — not determinable from the repository.
>
> **Scope of this report.** No source code was changed. No branches were merged or checked out. All branch analysis used read-only git commands against a clean working tree.
>
> **Snapshot point.** Branch `claude/objective-heyrovsky-142f3c` @ `61f05ea` (identical to branch `v1/strip-back-pr1`). Generated 2026-05-21.

---

## 1. Executive Summary

**What it is (Confirmed).** Relationship Inbox OS is a **local-first desktop tool that pulls your unread direct messages from several platforms into one prioritised inbox**. It runs entirely on your own machine. Instead of opening LinkedIn / iMessage / Instagram / TikTok separately, you get one list of conversations, sorted by who has been waiting longest for a reply. For each conversation it shows an AI-written summary of what the chat is about, what the other person wants, and which questions you haven't answered — so you don't have to reread anything. You then reply, either by yourself or with AI help, and clear the thread.

**The problem it solves (Confirmed, from `README.md`).** The friction that stops people replying: messages scattered across apps all ageing quietly; the work of rereading a cold thread to remember where it left off; and getting pulled into a social feed every time you open an app to deal with a message. A secondary problem is also addressed: not knowing how to *open* a conversation with someone new (the AI can generate grounded conversation starters from a person's public profile).

**Who it is for (Inferred).** People who chronically mean to reply and don't — the builder is the prototypical user. `README.md` is explicit and self-selecting: *"If you keep meaning to reply to messages and somehow never do, this might be useful… If none of that's your problem, this probably isn't for you."* A secondary audience is people doing professional outbound networking.

**Stage (Confirmed + Inferred).** A **working early-MVP built on a prototype's foundations**. It is feature-complete enough to use daily — `README.md` describes a real morning/through-day/end-of-day routine — and is unusually well-engineered for reliability (a 4,439-line runner, ~55 test files, a 22-entry bug audit). But it is **single-user, local-only, has no authentication, no multi-tenant concept, and `package.json` version is `0.1.0`**. It is not productised.

**Prototype / MVP / mature?** **An MVP in capability, a prototype in productisation.** The core loop works and is polished; the surrounding product (onboarding, accounts, "works for anyone but the author") does not yet exist.

---

## 2. Product Evolution

The repository shows a clear three-step journey.

**Step 1 — The feature-heavy version.** Before the current baseline, the dashboard exposed a full *operator console*: seven nav routes, a settings page full of automation knobs, and operator actions in the top bar. This is **Confirmed** by what the strip-back commits explicitly remove (see table below) and by the fact that those pages still exist in the tree. Automation defaults were also more aggressive — `LINKEDIN_SCAN_MAX_THREADS=200`, background profile-enrichment on by default, enrichment daily cap `40` (Confirmed, `.env.example` diff `pre-v1-stripback..HEAD`).

**Step 2 — The realisation: too much, and too personal.** The product was being built around one specific person.
- The AI casual-voice prompt hardcoded the operator's identity and demographic detail verbatim. [Removed: historical local operator voice prompt. Richard-specific profile data now lives only in the gitignored local seed file and the local SQLite operator_profile_v1 row.] (Was at `apps/runner/src/services/ai.ts:310`.)
- The LinkedIn voice prompt hardcoded the operator's voice with verbatim examples of their real messages. [Removed: see the note above.] (Was at `ai.ts:122`.)
- `README.md` is written in the first person about the author's own habits ("reply to my mum").
- The Today screen greets `"{greeting}, Richard."` as a hardcoded string (Confirmed, `apps/dashboard/app/today/page.tsx:275`).
- `.env.example` ships `PERSONAL_CHROME_PROFILE_NAME=Richard Afolayan`.

**Step 3 — The strip-back (current baseline).** A redesign ("Inbox OS redesign across 9 screens", commit `4486d01`) landed, then a deliberate **multi-PR strip-back** narrowed the product to "the inbox loop". The commit messages reference `PR1`, `PR1B`, `PR1D`, and a still-pending `PR2` — so the strip-back is **a planned, in-progress effort, not finished**.

| Step | Evidence (commit / file) | What changed |
|---|---|---|
| Redesign landed | `4486d01 feat(redesign): land Inbox OS redesign across 9 screens` | New visual design across Today/Inbox/At Risk/Archived/People/Platforms/Activity/Settings/Top-status |
| Hide non-v1 routes | `0734d48 chore(dashboard): hide non-v1 routes from sidebar nav` | Removed At Risk, People, Platforms, Activity from sidebar + ⌘K palette. *"v1 only surfaces the inbox loop (Today, Inbox, Archived, Settings)… PR2 of the v1 strip-back will decide which to delete."* |
| Strip settings | `c2cc6bb` + `69d0d7f chore(dashboard): re-strip redesigned settings page for v1` | Settings cut from a full operator console to 4 user controls |
| Strip top status | `cb8a261 chore(dashboard): strip operator actions from top status bar` | Removed Restart runner / Pause scans / Force re-enrich / View logs / Manage platforms; left read-only status |
| Dial back automation | `.env.example` diff, `a15af34 feat(runner): tune real anti-detection` | Scan cap `200→50`; auto-enrichment off by default; enrichment cap `40→10`; added a weekday active-hours window |

**Current direction (Confirmed).** "The inbox loop": **Today → Inbox → Archived**, plus **Settings**. Calm, low-surface-area, fewer knobs, less aggressive automation. The feature-heavy code was **hidden, not deleted** — see §3.

---

## 3. Current Stripped-Back Version (the source of truth)

**Core user flow (Confirmed).**
1. A scan pulls unread messages from connected platforms into the local database.
2. **Today** opens on the single most-overdue conversation as a "hero" card, with a peek at who's next.
3. The user opens a thread, reads the AI summary, and replies — by hand, or with an AI draft.
4. The user **marks the thread done** or **snoozes** it; it leaves the active inbox.
5. **Inbox** is the full list for working through everything; **Archived** is the history.

**Core screens (Confirmed).**

| Screen | File | Role |
|---|---|---|
| Today | `apps/dashboard/app/today/page.tsx` | Home. One hero thread (most overdue) with `R`/`S`/`E` keyboard actions, a 3-person "queue peek", and a right-rail day outline. |
| Inbox | `apps/dashboard/app/inbox/page.tsx` | All conversations. Risk tabs (All / Overdue / Waiting / Fresh / Snoozed), platform + kind + sort filters, search, multi-select bulk actions. |
| Thread | `apps/dashboard/app/thread/[id]/page.tsx` | Single-conversation workspace: message timeline + sticky composer, with a right rail for "what they want", open loops, and the compose-in-voice helper. |
| Archived | `apps/dashboard/app/archived/page.tsx` | Search-first, month-grouped history with an inferred archive reason (handled / snoozed / ghosted) and hover-to-restore. |
| Settings | `apps/dashboard/app/settings/page.tsx` | Four controls only (see below). |

**Main features → user problem.**

| Current Feature | What It Does | User Problem It Solves | Evidence/File Path | Notes |
|---|---|---|---|---|
| Unified inbox | Pulls unread DMs from LinkedIn + iMessage into one list, sorted by longest wait | Messages stranded across multiple apps, all ageing | `today/page.tsx`, `inbox/page.tsx`; `GET /data/inbox` | LinkedIn + iMessage are live; Instagram/TikTok beta; WhatsApp is a stub |
| Today hero + queue | Surfaces the one most-overdue thread; `R`=reply, `S`=snooze, `E`=mark done | Decision paralysis — not knowing where to start | `today/page.tsx:153` (hero), `:192` (keys) | Background-predrafts the top 3 threads (`today/page.tsx:172`) |
| Risk / SLA ageing | Threads age GREEN → AMBER → RED by hours since last inbound | "I've forgotten how long they've been waiting"; low-grade guilt | `packages/core/src/risk.ts:17` `calculateRisk` | Defaults: amber 6h, red 18h (`defaults.ts`) |
| AI thread summary | Rolling summary + one-line "what they want" + unanswered "open loops" | Rereading a cold thread to recover context | `ai.ts` `updateThreadSummary`; `schema.prisma` `Thread.rollingSummary/whatTheyWant/openLoopsJson` | Cached against an input hash |
| AI suggested replies | 3 sendable replies (reply mode), or 3 grounded re-openers (reopen mode) | "I don't know what to write" | `ai.ts:1053` `generateSuggestedReplies` | Reopen mode generates "you remembered" callbacks |
| Compose-in-voice | Turns a short intent ("decline politely") into a full message in the user's voice | Writing from a blank box is the core friction | `ai.ts` `composeInVoice`; `POST /control/thread/:id/compose` | Calibrated to outbound history of that thread |
| Shorten / Make warmer | Rewrites the user's own draft | Draft is too blunt or too long | `ai.ts:1227` `transformReply`; thread composer toolbar | |
| Outreach vs genuine | AI classifies each thread; an Inbox filter hides outreach noise | Inbox cluttered with pitches / spam | `ai.ts` `classifyThreadCategory`; `schema.prisma` `Thread.category` | |
| Snooze (+ AI timing) | Hides a thread until a time; AI reads time hints from messages | "Waiting on something before I can reply" | `schema.prisma` `Thread.snoozedUntil`; `ai.ts` `suggestSnoozeTimings` | Resurfaces automatically |
| Mark done / archive | Clears a thread from the active inbox | Closing the loop | `POST /control/thread/:id/mark-done`, `/archive` | Mark-done also archives an unreplied thread |
| Scheduled send | Sends a drafted reply at a future time | Decide now, deliver later | `schema.prisma` `SendRequest.scheduledFor`; `scheduled-send-promoter.ts` | |
| Bulk actions | Multi-select rows → mark done / snooze / rescan | Clearing broadcast / notification noise in batches | `inbox/page.tsx:268` `runBulk` | |
| Local-first storage | All data in a local SQLite file; nothing on a server | Privacy of sensitive relationship data | `schema.prisma` (sqlite); `README.md` | AI API calls do leave the machine — see §10/§11 |
| Operator profile | Two free-text boxes (about / interests) feed the AI prompts | Keep replies in the user's domain and voice | `settings/page.tsx:178`; `ai.ts` `operatorProfileFragment` | |

**What is intentionally kept simple (Confirmed).**
- **Navigation** is 4 routes (`sidebar.tsx` nav array: Today, Inbox, Archived, Settings).
- **Settings** is 4 controls: Auto-scan, Quiet hours, Headless browser, and the About-me textareas (`settings/page.tsx:13-17` documents this scope decision in a comment).
- **Top status bar** is read-only — connected-platform pip, an activity ticker, "scan Xm ago" — with all operator actions removed (`cb8a261`).
- **Sending is always user-triggered** — there is no autonomous send loop (Confirmed, `README.md`; runner can scan/draft/queue/schedule but a human clicks send).

**What has been removed or avoided (Confirmed) — and an important nuance.** The strip-back **hid features from the v1 surface; it did not delete the code.** These routes still exist as files and resolve if a URL is typed directly:
- `apps/dashboard/app/at-risk/page.tsx` — relationship-decay triage view
- `apps/dashboard/app/people/page.tsx` — relationship/CRM panel with profile enrichment + conversation starters
- `apps/dashboard/app/platforms/page.tsx` — connect / scan / selector-test console
- `apps/dashboard/app/logs/page.tsx` — activity log / receipts
- The operator console in Settings (scan interval, amber/red thresholds, max messages, AI provider picker, enabled-platforms, model overrides, demo mode, danger-zone resets, restart runner) — removed from the UI but the **runner routes still exist** (e.g. `GET /data/ai-status` at `index.ts:1240`).

So the baseline is a **narrowed surface over a full-featured engine**. PR2 of the strip-back is explicitly deferred to "decide which to delete" (`0734d48`).

**Assumptions the current product makes about its user (Inferred unless noted).**
- There is exactly **one user** — and, in the AI layer, that user is hardcoded as "Richard" (Confirmed, `ai.ts`).
- They are on **macOS** (iMessage adapter drives Messages.app; `.env.example` has a macOS Chrome path).
- They have **Chrome installed** and are comfortable signing into it (personal-profile mode).
- They are comfortable running a **localhost dev stack** (`npm run dev`, two ports) — there is no packaged app.
- They accept **browser automation against their own logged-in accounts** and the associated platform-ToS risk.
- They want **AI on by default** and will supply an API key.

---

## 4. Original / Feature-Heavy Version

The earlier broader product is reconstructable from (a) the strip-back commit messages, (b) the still-present hidden pages, and (c) git history / branches.

| Earlier Feature / Idea | Purpose | Risk / Why It May Have Been Too Much | Keep / Park / Drop | Evidence |
|---|---|---|---|---|
| **At Risk page** | Triage threads as "relationship decay" (Critical 7d+ / At risk 3-7d / Watch) with a "Warm up" CTA | Overlaps Today + Inbox's Overdue tab; a third view of the same data | **Park** | `app/at-risk/page.tsx` (present, unlinked); `0734d48` |
| **People page (relationship CRM)** | Per-person panel: profile enrichment, AI summary, conversation starters, notes, friendship summary, "ask about this person" | This is a *second product* (a CRM) bolted onto an inbox; biggest single source of scope creep | **Park** (the conversation-starter / networking idea is valuable later) | `app/people/page.tsx`; `conversation-starters.ts`; `ai.ts` `askAboutPerson`, `summarisePersonForFriendship` |
| **Platforms console** | Connect, run scans, run selector tests, save selector overrides, reset sessions | Operator/debugging surface, not an end-user surface | **Park** (needed for connect, but as onboarding, not a console) | `app/platforms/page.tsx`; `cb8a261` |
| **Activity log / receipts** | Audit trail of every scan/send with screenshots + DOM dumps | Valuable for debugging, noise for a user | **Park** | `app/logs/page.tsx`; `schema.prisma` `AuditLog` |
| **Operator settings console** | Scan interval, amber/red thresholds, max-messages, AI provider picker, enabled-platforms, model overrides, demo mode, runner restart | Every knob is a decision the user shouldn't have to make | **Drop** from the user surface (keep as env/config) | `c2cc6bb`, `69d0d7f` commit bodies |
| **Danger zone** (Reset LinkedIn / Reset iMessage + admin token) | Wipe a platform's data | Destructive; not a daily-use control | **Drop** from UI (keep as CLI/admin) | `c2cc6bb`; `POST /admin/reset` |
| **Background profile enrichment** | Auto-visit strangers' LinkedIn profiles to scrape posts/headline | *"the closest thing this app does to actual scraping and the most fingerprint-able activity it performs"* — detection risk | **Park** (now off by default) | `.env.example` `ENRICH_AUTO_ENABLED`; `enrichment-queue.ts` |
| **Aggressive scan volume** | `LINKEDIN_SCAN_MAX_THREADS=200` | Volume-detection / account-flag risk | **Drop** (already cut to 50) | `.env.example` diff |
| **Conversation starters / "networking" mode** | Generate grounded cold-opener messages from a person's public profile | A distinct second value prop; dilutes the "reply to what's waiting" focus | **Park** — strong idea, wrong time | `README.md` "When you want to start a conversation"; `conversation-starters.ts` |
| **Multi-AI-provider picker** | Choose OpenAI / GLM / Gemini in the UI | A power-user choice | **Drop** from UI (now env-only `AI_PROVIDER`) | `c2cc6bb`; `ai-providers.ts` |
| **WhatsApp / Instagram / TikTok breadth** | More platforms | Each platform is an automation maintenance burden; breadth before the core is validated | **Park** | `platform-factory.ts` (WhatsApp = not-implemented stub); `beta-adapter.ts` |

**Signs it was built around the author's own use (Confirmed).**
- The AI voice is **the author's voice, hardcoded** — a full personal slang dictionary, a fixed emoji palette, sentiment modes, and few-shot examples of the author's real texts (`ai.ts:310`, `ai.ts:122`). The product literally cannot draft authentically for anyone else as shipped.
- `README.md` is a personal essay ("reply to my mum", "Twenty minutes gone, three reels watched").
- Hardcoded `"Richard"` in the Today greeting; `PERSONAL_CHROME_PROFILE_NAME=Richard Afolayan` in `.env.example`.
- The breadth of platforms and the CRM features look like "everything I personally might want", not a scoped MVP.

---

## 5. User Feedback Already Reflected

**I could not find direct user feedback in the repository.** There are no issue exports, user-research notes, feedback documents, survey results, interview transcripts, or commits that quote a user. The repository contains code, engineering docs (`README.md`, `CODEBASE_OVERVIEW.md`, `AGENTS.md`, `BUG_AUDIT.md`, `docs/headless-mode.md`, `VERIFICATION_CHECKLIST.md`), and git history — all author-facing.

**What can still be inferred (clearly marked Inferred):**
- The **strip-back itself is the artefact of feedback.** A deliberate, multi-PR effort to remove the operator console and narrow to "the inbox loop" is consistent with the user's stated history ("stripped the product back after user feedback"). The commits describe *what* was removed but never *why a user asked for it* — so the feedback content is not in the repo.
- The **anti-detection hardening** (scan 200→50, enrichment off by default) suggests either a real incident or a real concern about platform bans. `platform-factory.ts` references a *"2026-05-08 incident"* with LinkedIn auto-login — this is a concrete, dated event, though framed as a technical incident, not user feedback.
- The README's *"a lot of people have already liked it"* framing (from the task brief) is **not evidenced anywhere in the repo** — treat the size and nature of that positive reception as **Unknown**.

**What feedback is missing / not documented:** everything qualitative — who the users are, what they liked, what confused them, whether they would pay, what they wanted removed, whether manual entry / connecting accounts was acceptable. None of it is captured in the repository. **This is the single biggest gap for planning** and should be the priority of the next discovery round (§15, §17).

---

## 6. Personas Implied By The Product

Inferred from the product surface, the README, and the AI prompts. No persona document exists in the repo.

| Persona | Pain Point | Product Fit | Evidence | Confidence |
|---|---|---|---|---|
| **The guilty non-replier** (the core user; mirrors the author) | Means to reply, never does; conversations go cold; rereading feels like work; opening the app means losing 20 minutes to a feed | The entire loop — unified inbox, longest-wait sort, AI catch-up summary, no feed — is built around exactly this friction | `README.md` ("Who this is for"); Today hero; risk ageing | **High** |
| **The professional networker / founder** | Wants to maintain *and* start relationships at scale; spends half an hour "stalking" a profile to find an opener | LinkedIn-first scanning, profile enrichment, AI conversation starters grounded in someone's posts | `README.md` ("start a conversation"); `conversation-starters.ts`; LinkedIn is "the most polished" | **Medium** |
| **The multi-platform social user** | DMs scattered across iMessage / WhatsApp / Instagram / TikTok; mum on iMessage, peers on LinkedIn | Multi-platform adapters; casual-voice AI tier for messaging apps | `PlatformName` enum; `CASUAL_VOICE_PROMPT`; iMessage adapter | **Medium** (only LinkedIn + iMessage actually work today) |
| **The privacy-conscious user** | Doesn't want relationship data on someone else's server | Local-first SQLite; runs on your own machine; AI can be turned off | `README.md`; `schema.prisma` sqlite | **Medium** (an enabling property, probably not a primary buying reason) |
| **The "relationship CRM" user** | Wants to actively manage a relationship graph (notes, tags, decay tracking) | At Risk + People pages, notes, friendship summaries — **but these are hidden in v1** | `app/people/page.tsx`, `app/at-risk/page.tsx` (unlinked) | **Low** — the strip-back is a deliberate bet *against* this persona for now |

---

## 7. Jobs-To-Be-Done Implied By The Product

| Situation | Job-To-Be-Done | Current Feature Supporting It | Gap |
|---|---|---|---|
| I feel guilty about not replying to someone | Re-enter the conversation calmly, without shame and without rereading everything | Today hero + AI summary + "what they want" + open loops; late-reply AI prompt that opens with a natural apology (`ai.ts` `lateReplyHint`) | None major — this is the best-served job |
| I have many messages waiting and don't know where to start | Be told the single most important one to do right now | Today hero (most-overdue first) + queue peek + `R`/`S`/`E` keys | Priority is purely time-since-inbound; no notion of *who matters more* |
| I open an app to reply and get sucked into the feed | Deal with messages without ever seeing the feed | Background scan pulls messages; the dashboard has no feed | Reading is covered; the *send* still drives the real platform UI under the hood |
| I want to reply but can't face writing it | Get a sendable draft that sounds like me | `composeInVoice`, `generateSuggestedReplies`, predraft | Voice is **hardcoded to the author** — does not yet sound like *anyone else* |
| Someone asked me something I can't answer yet | Park the thread until I can, without losing it | Snooze (+ AI snooze-timing), scheduled send, open-loop reminders | Works; "open loop" reminders are a lighter-weight path that is less surfaced |
| My inbox is full of pitches and notifications | Separate real conversations from noise and clear the noise fast | Outreach/genuine classification + Inbox filter + bulk actions | Relies on AI classification accuracy; no user-visible correction loop |
| A conversation has gone quiet and I want to revive it | Reopen warmly with something specific they'll remember | "Reopen mode" in `generateSuggestedReplies` (grounded callbacks) | Discoverability — reopen mode triggers implicitly; not an obvious user action |
| I want to message someone I've never spoken to | Open with something specific to them, not "Hi, hope you're well" | AI conversation starters from profile enrichment | **Hidden in v1** (lives on the People page) |

---

## 8. User Stories Already Supported

| User Story | Supported Now? | Evidence | Missing Piece |
|---|---|---|---|
| As a user, I see all my unanswered messages in one place | **Yes** (LinkedIn + iMessage) | `inbox/page.tsx`, `today/page.tsx` | Instagram/TikTok beta-only; WhatsApp stub |
| As a user, I'm shown who has been waiting longest | **Yes** | `today/page.tsx:142` sort; `risk.ts` | — |
| As a user, I can catch up on a thread without rereading it | **Yes** | AI rolling summary, "what they want", open loops | Depends on summary quality / freshness |
| As a user, I can reply in my own voice with AI help | **Partial** | `composeInVoice`, suggested replies | Voice is the **author's**, hardcoded — not the current user's |
| As a user, I can soften or shorten a draft I wrote | **Yes** | `transformReply` (SHORTEN / MAKE_WARMER) | — |
| As a user, I can snooze a thread until I'm ready | **Yes** | `Thread.snoozedUntil`, `suggestSnoozeTimings` | — |
| As a user, I can schedule a reply to send later | **Yes** | `SendRequest.scheduledFor`, `scheduled-send-promoter.ts` | — |
| As a user, I can clear pitches/noise quickly | **Yes** | Classification + Inbox filter + bulk actions | No way to correct a misclassification in-product |
| As a user, I can archive handled threads and find them later | **Yes** | `archived/page.tsx` | — |
| As a user, I can connect a new platform | **Partial** | `platforms/page.tsx` exists but is **hidden from nav** | No connect entry point in the v1 nav |
| As a user, I can set up the product as *me* (not the author) | **No** | `ai.ts` hardcodes "Richard"; `today/page.tsx:275` hardcodes the greeting | No identity/voice onboarding |
| As a user, I can sign in / use this as an account | **No** | No auth anywhere in `apps/dashboard` or `apps/runner` | Single-user, local-only by design |
| As a user, I get a packaged app I can just run | **No** | `npm run dev` dev stack only | No installer / no build target |

---

## 9. Product Principles Implied By The Build

| Principle | Followed? | Evidence | Contradictions / Tension |
|---|---|---|---|
| **Calm over noisy** | **Strongly** | Read-only top status; quiet hours; weekday active-hours window; "You're caught up" empty states; no feed | — |
| **Reconnection over inbox zero** | **Partially** | "Reopen mode" generates warm re-openers; late-reply prompt removes shame; Archived infers a "ghosted" reason | The dominant metaphor is still *inbox* — tabs, "X need you tonight", a Done counter. The framing rewards clearing, not relating. |
| **People are not pipelines** | **Mixed** | "Genuine vs outreach" protects real relationships; no deal stages | Threads carry `riskLevel`, `slaDueAt`, "SLA breached", `whatTheyWant` — borrowed from sales/support ops. The hidden At Risk page literally triages "relationship decay". |
| **Memory support over AI ghostwriting** | **Contradicted** | The product *does* support memory (summaries, open loops, "ask about this person") | But it also **ghostwrites heavily** — `composeInVoice` and suggested replies produce complete sendable messages in a cloned voice. This is the principle most in tension with the build. |
| **Simple before automated** | **Partially** | The strip-back removed knobs; auto-enrichment is now off | The engine is deeply automated (scan scheduler, AI on every thread, predraft, send queue). Simplicity was applied to the *surface*, not the *engine*. |
| **Manual before integrations** | **Followed (in spirit)** | No official platform APIs — it drives a real browser (`README.md`: "Browser automation only in v1") | But it is the *opposite* of "manual data entry": everything is auto-scraped. The principle here is "no API partnerships", not "user types things in". |
| **Authenticity / sounds like a human** | **Followed, with caveats** | Strong hallucination guards; "don't fake typos"; empty-fallback honesty instead of canned replies; British-English voice rules | Authenticity is achieved by **impersonating one specific real person** — which is authentic for that person and inauthentic for everyone else. |
| **Privacy / local-first** | **Followed** | SQLite on-device; no server; AI can be disabled | AI calls do send conversation content to a third-party LLM provider — a real, disclosed exception. |

---

## 10. AI Usage and Boundaries

**AI is present and central — it is not a peripheral feature.** Confirmed in `apps/runner/src/services/ai.ts` (1,920 lines) and `apps/runner/src/services/conversation-starters.ts`.

**Providers (Confirmed).** Multi-provider via an OpenAI-compatible interface: **OpenAI** (default, `gpt-5-nano`), **GLM / Z.AI**, **Google Gemini / Gemma**. Selected by the `AI_PROVIDER` env var (the in-UI picker was stripped). A fallback chain across providers exists (`ai-providers.ts`).

**What the AI does (Confirmed — the full `AiService` interface, `apps/runner/src/types/runtime.ts:70`):**

| AI capability | Method | What it produces |
|---|---|---|
| Thread summary | `updateThreadSummary` | Rolling summary, one-line "what they want", list of open loops |
| Suggested replies | `generateSuggestedReplies` | 3 sendable replies, or 3 grounded re-openers in "reopen mode" |
| **Ghostwrite from intent** | `composeInVoice` | A complete sendable message from a short intent, in the user's voice |
| Rewrite a draft | `transformReply` | The user's own draft, shortened or made warmer |
| Classify a thread | `classifyThreadCategory` | "outreach" vs "genuine" |
| Contact intro | `generateContactSummary` | A 2-3 sentence intro to a person from their profile |
| Conversation starters | `generateConversationStarters` | 2-3 cold openers grounded in cited profile fields |
| Snooze timing | `suggestSnoozeTimings` | Snooze targets read from time hints in messages |
| Friendship summary | `summarisePersonForFriendship` | 4-section "how you know each other" summary |
| Q&A about a person | `askAboutPerson` | Free-text answers grounded in messages/notes |

**So: yes — the AI writes messages, summarises context, suggests prompts, classifies relationships, and answers questions about people.** It is the product's main intelligence layer.

**Safeguards (Confirmed — genuinely substantial):**
- **Sending is always user-triggered.** AI drafts; it never sends. No autonomous send loop (`README.md`).
- **Hallucination guards** in every voice prompt: *"ONLY use details that are literally in their message or in the thread history… if you can't quote the relevant phrase back, don't include it"* (`ai.ts:186`).
- **Citation validation** for conversation starters — each starter must cite a real, populated profile field or it is dropped (`conversation-starters.ts:117` `isFieldPopulated`).
- **Attribution discipline** — the system prompt forbids confusing who said what (`ai.ts:83`).
- **Honest empty fallback** — on AI failure it returns *no* replies plus a plain explanation rather than inventing canned text (`ai.ts:1149`).
- **Caching** keyed on input hashes, so the AI is not re-run on unchanged threads.

**Does AI usage support or conflict with the emotional / authenticity direction?** **Both.**
- *Supports it:* the guards, the no-autonomous-send rule, the "don't fake typos / don't over-polish" rules, and the empty-fallback honesty are all aimed squarely at not putting fake words in the user's mouth.
- *Conflicts with it:* the casual-voice prompt is a **hardcoded clone of one named individual** (`ai.ts:310`). For the author it is authentic; for anyone else it is impersonation. A product whose pitch is calm, shame-free, *genuine* reconnection currently hands every other user the author's slang and emoji. **De-personalising the voice layer is the central unresolved AI question** (see §15, §16).

---

## 11. Data Model and Privacy

**Where data lives (Confirmed).**
- **Database:** local **SQLite** via Prisma (`schema.prisma`; `DATABASE_URL=file:./data/inbox-os.sqlite`). On the user's machine.
- **Browser profiles, screenshots, DOM dumps, run logs:** local files under `data/` and `logs/`.
- **iMessage:** read directly from the macOS `chat.db`; sent via AppleScript driving Messages.app.
- **AI:** conversation content is sent to the configured **third-party LLM provider** over the network. This is the one material data egress.
- **Authentication:** **none.** No login, no accounts, no per-user isolation anywhere in the dashboard or runner.

**Data model (Confirmed, `packages/core/prisma/schema.prisma`).** Models: `Platform`, `Person`, `PersonEnrichment`, `EnrichmentJob`, `Thread`, `Message`, `Draft`, `AuditLog`, `Setting`, `SendRequest`.

| Data Type | Where Stored | Why Needed | Sensitivity | Risk / Notes |
|---|---|---|---|---|
| Message content (in/out) | SQLite `messages` | The core artefact — the conversations themselves | **Very high** — private correspondence | Sent to the LLM provider for summarising/drafting |
| People / contacts | SQLite `people` | Identify who a thread is with | **High** — names, handles, phone numbers, profile URLs | iMessage identifiers are phone numbers/emails |
| Profile enrichment | SQLite `person_enrichments` | Power AI summaries + conversation starters | **High** — scraped LinkedIn data on third parties who never consented | Scraped from public profiles; auto-enrichment now off by default |
| AI-derived thread context | `threads.rollingSummary/whatTheyWant/openLoopsJson/suggestedRepliesJson` | Avoid rereading; cache AI output | **High** — AI inferences about private chats | Cached on disk |
| Drafts & send requests | SQLite `drafts`, `send_requests` | Hold unsent/scheduled replies idempotently | **High** | `clientSendId` makes sends idempotent |
| Audit log + artifacts | SQLite `audit_logs` + files under `data/` | Debugging scans/sends | **Medium** — screenshots/DOM dumps can contain message text | `DEV_LOG_PII=0` exists as a PII-logging gate |
| Browser session / cookies | Mirrored Chrome profile on disk | Stay logged in to platforms | **Very high** — live session credentials | A "cookie bridge" decrypts the real Chrome session |
| Settings + operator profile | SQLite `settings`; localStorage | Behaviour + AI personalisation | **Low–Medium** | Operator about/interests text goes into AI prompts |
| API keys | `.env` (gitignored) | LLM provider auth | **High** | `.env.example` holds only blank placeholders — no real secrets in the repo |

**Privacy / security observations (Inferred unless noted).**
- **No authentication or encryption-at-rest.** Anyone with access to the machine/files has every conversation. Acceptable for a single-user local tool; a hard blocker for any hosted/multi-user future.
- **The biggest privacy exposure is the LLM provider.** Private message content is transmitted off-device by default. It is disclosed in `README.md` and AI can be turned off, but it is the main thing a privacy-led product must be explicit about.
- **Enrichment scrapes non-consenting third parties.** The `.env.example` comments are unusually candid that this is "the most fingerprint-able activity it performs" — both a platform-ToS risk and a data-ethics consideration.
- **No real secrets are committed** — `.env.example` placeholders only (Confirmed).
- The token-guarded `POST /admin/reset` and `DEV_LOG_PII` flag show security was considered at the engineering layer even though there is no product-level auth.

---

## 12. Technical Architecture

**Stack (Confirmed).**
- **Monorepo:** npm workspaces + Turbo. Node ≥ 20. TypeScript throughout.
- **Frontend:** `apps/dashboard` — Next.js (App Router) + React + Tailwind. Client-rendered pages that proxy to the runner. State is local React `useState`/`useEffect` + SSE — no Redux/Zustand.
- **Backend:** `apps/runner` — Express + Playwright. One ~4,439-line `index.ts` holds ~60 routes. Drives real Chrome via Playwright; talks to LLM providers.
- **Shared:** `packages/core` — Prisma schema, shared TS types, risk logic, platform selectors, autoscan rules, defaults.
- **Database/storage:** SQLite via Prisma; runtime artifacts as local files.
- **Authentication:** none.
- **External services:** LLM providers (OpenAI / GLM / Gemini); the social platforms themselves, via browser automation (no official APIs).

**Platform support (Confirmed, `platform-factory.ts`).** LinkedIn — mature (`LinkedInAdapter`). iMessage — working (`IMessageAdapter`, reads `chat.db`, sends via AppleScript). Instagram + TikTok — beta (shared `BetaAdapter`, degrades gracefully). WhatsApp — **foundation stub only** (`createNotImplementedAdapter("WHATSAPP")`); enum + schema columns exist, the adapter does not.

**Folder structure.**
```
apps/dashboard/   Next.js UI — app/{today,inbox,thread,archived,settings, at-risk,people,platforms,logs}
apps/runner/      Express+Playwright — src/{index.ts, platforms/, services/, linkedin/, scripts/}
packages/core/    Prisma schema, types, risk.ts, selectors, defaults, autoscan
tests/            ~55 node:test integration tests
```

**Key files to read first.** `apps/runner/src/index.ts` (all routes); `apps/runner/src/platforms/linkedin-adapter.ts` (canonical adapter); `apps/runner/src/services/ai.ts` (all AI + the voice prompts); `packages/core/prisma/schema.prisma` (data model); `apps/dashboard/app/thread/[id]/page.tsx` (the workspace, 3,182 lines).

**How to run it locally (Confirmed, `README.md` / `package.json`).**
```bash
npm install
npx playwright install
npm run db:generate && npm run db:push
# create .env (OPENAI_API_KEY, RUNNER_PORT=4001, DASHBOARD_PORT=3100, …)
npm run dev          # db gen/push + core build + dashboard + runner
```
Dashboard at `http://localhost:3100`, runner at `http://localhost:4001`. `npm run dev:fast` skips the db/build steps.

**Testing & CI (Confirmed).** ~55 `node:test` integration tests (`tests/*.test.mjs`), heavily weighted to LinkedIn scan reliability and AI voice/classifier tiers. GitHub Actions (`.github/workflows/ci.yml`) runs `lint` + `test:all` on PRs/pushes to `develop`/`staging`/`main`.

**Technical debt / fragile / unclear areas (Confirmed + Inferred):**
- **`apps/runner/src/index.ts` is a 4,439-line single file** — ~60 routes, the clearest refactor target.
- **`apps/dashboard/app/thread/[id]/page.tsx` is 3,182 lines** — the most-edited file in the repo and the highest merge-conflict risk for any branch work.
- **Browser-automation fragility is inherent and acknowledged.** `BUG_AUDIT.md` logs 22 reliability bugs, almost all LinkedIn scan/session issues; selector overrides exist precisely because platform UIs shift.
- **Stale documentation.** `README.md` and `CODEBASE_OVERVIEW.md` both say iMessage is not UI-exposed / list only LinkedIn+Instagram+TikTok — but iMessage is a live, filterable v1 platform. The docs predate the iMessage work.
- **Version drift.** `package.json` is `0.1.0` while git tags `v0.2.0` / `v0.3.0` exist.
- **No frontend unit/component tests** — `dashboard` has one logic test (`dashboard-run-action.test.mjs`); pages are untested. UI verification is manual (`VERIFICATION_CHECKLIST.md`).
- **Worktree gotcha** (from `AGENTS.md`): the Turbo dev daemon can serve main-project files when run from a worktree.

---

## 13. Branch and Feature Inventory

> Treat this as an **inventory, not a to-do list.** The repo has ~70 local branches. The current baseline (`v1/strip-back-pr1`) has **already absorbed most `feat/*` work** — many branches are merged-in or superseded. **No merges are recommended below** except where explicitly noted as low-risk.

**Reference branches.**

| Branch | Apparent Purpose | Key Differences | Status | Future Value | Risk |
|---|---|---|---|---|---|
| `claude/objective-heyrovsky-142f3c` | The worktree branch = current baseline | Identical to `v1/strip-back-pr1` | Current | — | — |
| `v1/strip-back-pr1` | The stripped-back v1 product | The baseline itself | Active | This *is* the direction | — |
| `archive/pre-v1-stripback` | Snapshot of the feature-heavy version before the strip-back | = `staging` = tag `pre-v1-stripback` | Archived on purpose | Recovery point for stripped features | — |
| `main` / `staging` / `develop` | Long-lived integration lines | All *behind* the baseline; `develop` has 1 unmerged commit (action-feedback PR #183) | Stale vs baseline | `develop`'s 1 commit only | Low |

**Future-feature branches (genuine net-new work).**

| Branch | Apparent Purpose | Key Differences | Status | Future Value | Risk |
|---|---|---|---|---|---|
| `feat/whatsapp-integration` (also on `origin`) | Real WhatsApp via `whatsapp-web.js` | Full 8-method adapter, QR pairing card, group resolver, saved-contact send guard; 5 test files | **Complete, the most finished WhatsApp branch** | **High** — if WhatsApp is wanted, this is the one | High — adds a heavy dependency (`package-lock` +2,824), type-refactor will conflict |
| `claude/pensive-agnesi-929410` (= `feat/send-ripple`) | "Centrepiece" send animation + reusable motion system | New `lib/motion.ts` + `components/motion/*` (net-new); 1 redundant toast commit | Ripple complete | Medium — polish, not core | Low for the motion files; the toast commit is already superseded |
| `claude/angry-bohr-f060d4` (tag `v-thread-workspace-compact`) | Collapsible sidebar + compact thread workspace | `[`-toggle 200px↔56px sidebar; large thread-page rework (+672/−264) | Appears complete (UI-only) | Medium | High conflict on `thread/[id]/page.tsx` |
| `feat/profile-enrichment-overhaul` | Richer LinkedIn enrichment + profile drawer (PR 1 of 2 for issue #100) | `followersCount`, recent reactions, URL auto-discovery | **Largely superseded** — most landed in the baseline | Low — cherry-pick leftovers only | High divergence (oldest merge-base) |

**Superseded / redundant branches (do not use — would regress the baseline).**

| Branch group | Why redundant |
|---|---|
| `feat/imessage-adapter` (23 commits), `feat/imessage-*` family, `feat/casual-dm-voice-profile`, `feat/per-thread-voice-calibration`, `feat/linkedin-scan-scope`, `feat/snooze-hides-thread`, `feat/ai-rail-context-aware`, `feat/inbox-os-redesign`, `feat/linkedin-recent-activity-parsers` | All **already merged into the baseline** (the strip-back rebuilt them in). Re-merging would revert refinements. |
| `feat/redesign-inbox-filters`, `feat/redesign-sidebar-routes` | **Earlier redesign experiments** off the old `feature/new-dashboard-design` line — superseded by the merged `feat/inbox-os-redesign`. |
| `feat/whatsapp-adapter`, `feat/whatsapp-phase-b` | WhatsApp foundation stub / explicit WIP salvage commit — superseded by `feat/whatsapp-integration`. |
| `claude/laughing-sutherland-662bb5` (~73 commits, +5,758) | **Pre-strip-back history**, not a feature branch — the baseline was carved *back* from this line. Merging would re-inflate exactly what the strip-back removed. Reference only. |
| ~20 `claude/<random-word>` branches | Agent scratch branches; all merged-in, no unique work. |

**Bug-fix / chore / experimental branches (inventory only).**

| Branch | Purpose | Status | Note |
|---|---|---|---|
| `fix/audit-2026-05-comprehensive` (7 commits) | Bundled hardening audit — schema integrity, runner HTTP, AI fallback, iMessage/LinkedIn, dashboard SSE | Partly unmerged | Two commits confirmed *not* in baseline: `fc20186` (schema referential integrity) and `2318f87` (AI fallback in plain-text paths). The rest needs hunk-level review. **Medium-high conflict risk.** |
| `codex/performance-fast-paths` (4 commits) | Experimental perf branch from a different tool | Mostly superseded | Headline AI-registry feature already in baseline; only 2 undocumented perf commits are unique. Do not merge wholesale. |
| `chore/dead-runner-code` (1) | Removes remnants of 10 deleted control routes | Complete, comments-only | Low risk; possibly already applied. |
| ~12 single-commit `fix/*` branches (`fix/mark-done-archives-unreplied`, `fix/sla-countdown-replied-threads`, `fix/linkedin-cancel-scan`, `fix/platform-disabled-pill`, `fix/inbox-sibling-collapse`, `fix/at-risk-hide-ancient`, `fix/beta-adapter-timestamps`, `fix/connected-count-implemented-platforms`, `fix/imessage-settings-honor`, `fix/inbox-view-archived`, `fix/linkedin-duplicate-person-badge`, `fix/today-hero-headline-fit`) | Individual bug fixes | **Very likely all superseded** | Each has a PR-numbered twin in pre-strip-back history; almost certainly re-applied in the baseline under different hashes. Verify with a one-line grep before discarding. |

**Bottom line:** the only branches carrying *genuine, non-superseded* value are `feat/whatsapp-integration` (a real feature, high integration cost), `claude/pensive-agnesi-929410` (send-ripple polish), `claude/angry-bohr-f060d4` (compact workspace), and two specific commits inside `fix/audit-2026-05-comprehensive`. **None of these are needed for the next step in §16.**

---

## 14. What Has Already Been Answered

| Question | Answer So Far | Evidence | Confidence |
|---|---|---|---|
| Is a stripped-back product better than a feature-heavy one? | **Decided: yes.** A deliberate multi-PR strip-back to "the inbox loop" was executed and is the current baseline. | `0734d48`, `c2cc6bb`, `69d0d7f`, `cb8a261` | **High** (as a decision; its *market* validation is Unknown) |
| Which pain point is strongest? | The "guilty non-replier" pain — rereading, forgetting, feed-distraction. The whole loop is built on it. | `README.md`; Today hero design | **High** (as the product's bet) |
| Which features are core vs optional? | Core = Today / Inbox / Thread / Archived / Settings. Optional = At Risk / People / Platforms / Logs (hidden, not deleted). | `sidebar.tsx` nav scope; `0734d48` | **High** |
| Should the operator console be in the user UI? | **No.** Knobs moved to env vars; danger zone removed from UI. | `c2cc6bb`, `69d0d7f` | **High** |
| Is automation a detection risk worth dialling back? | **Yes.** Scan volume cut 200→50, enrichment off by default, active-hours window added. | `.env.example` diff; `a15af34` | **High** |
| Is AI necessary to the product? | **Treated as yes** — AI is the central intelligence layer (10 methods) — but it is designed to be **switch-off-able**. | `ai.ts`; `README.md` ("turn AI off entirely") | **Medium** — necessity is assumed, not user-validated |
| Should sending ever be autonomous? | **No.** Sending is always user-triggered, by deliberate design. | `README.md`; no send loop in `index.ts` | **High** |
| Which platform leads? | **LinkedIn**, with iMessage as the working second. | `linkedin-adapter.ts` maturity; `README.md` | **High** |
| Do people understand the concept? | **Unknown.** No user feedback in the repo. | — | **Low** |
| Is manual entry / connecting accounts acceptable to users? | **Unknown.** The product avoids manual entry (auto-scrape); whether users accept the *connect* step is undocumented. | — | **Low** |
| Are integrations (more platforms) needed immediately? | **Decided: no, not immediately.** WhatsApp left as a stub; breadth parked. | `platform-factory.ts` | **Medium** |

---

## 15. What Still Needs To Be Figured Out

**Product questions.**
- Is the core value "catch up on what's waiting" or "maintain/start relationships"? The build still straddles both (inbox loop vs the parked People/networking surface).
- Should the metaphor stay *inbox* (clear it) or shift toward *relationships* (tend them)? §9 shows the build is in tension with its own stated principles.
- Of the hidden routes (At Risk / People / Platforms / Logs), which get **deleted**, which get **reworked into the loop**, which stay parked? This is the explicit, undecided "PR2".
- Is the conversation-starter / networking capability a future pillar, or scope to drop?

**User research questions.**
- **Who actually liked the stripped-back version, and what specifically did they like?** This is the single biggest unknown — nothing about it is in the repo.
- What confused or blocked them? Did anyone fail to connect a platform, or stop at the AI voice?
- Would they trust AI-drafted replies enough to send them? Would they pay?
- Is "runs locally on your Mac" a feature users value, or friction they tolerate?

**Technical questions.**
- How is the **hardcoded "Richard" voice** replaced so the product works for anyone? (Onboarding-driven voice vs. learned-from-history voice vs. generic register.)
- Does the product stay **local-only**, or move toward a packaged app / hosted service? This decides whether auth, encryption, and multi-tenancy are ever needed.
- How sustainable is browser-automation scraping against ToS and detection? What is the contingency when LinkedIn changes its UI mid-week?
- Should `index.ts` (4,439 lines) and `thread/[id]/page.tsx` (3,182 lines) be refactored before more feature work lands on them?

**Privacy / trust questions.**
- How is "private message content is sent to an LLM provider" communicated and consented to?
- Is scraping non-consenting third parties' profiles (enrichment) acceptable for the product you want to be?
- If the product is ever shared/hosted, what is the data-protection story (auth, encryption-at-rest, deletion)?

**MVP scope questions.**
- Is the MVP **LinkedIn-only**, or LinkedIn + iMessage? (iMessage ties the MVP to macOS.)
- Is AI in the MVP, or an opt-in layer over a manual core?
- Is a packaged/installable build in the MVP, or does it stay a dev-stack tool?

**Launch / positioning questions.**
- One-line positioning: a *reply assistant*, a *personal relationship CRM*, or an *anti-distraction inbox*?
- Pricing model — local one-time, subscription, or free tool?
- How is platform-ToS risk disclosed to users at launch?

---

## 16. Recommended Next Build Step

**Recommendation: make the product work authentically for a second person — replace the hardcoded "Richard" identity with a one-time voice/identity setup — and finish the strip-back's deferred "PR2" route decision in the same pass.**

**Why this, and only this.** The strongest evidence in the entire repository is that the product **cannot currently be used by anyone but the author**: the AI casual-voice prompt is a hardcoded clone of one named individual (`ai.ts:310`), the Today greeting is a hardcoded string (`today/page.tsx:275`), and `.env.example` ships his name. Everything else — the inbox loop, the AI tools, the reliability work — is already built and polished. **The thing blocking you from learning more from "the people who liked it" is that you cannot actually give it to them as a working product.** Closing that gap is the smallest change with the largest unlock: it converts a personal tool into something a handful of real users can run, which is the precondition for the genuine user feedback that §15 shows is the biggest missing input.

**What to build (small, concrete):**
1. A one-time **voice/identity setup**: name, and a short voice sample or guided description that *drives* the AI voice prompt — instead of the hardcoded persona. The Settings "operator profile" textareas and `operatorProfileFragment()` already exist as the seam; the work is making the operator profile *the* voice source, not an additive footnote on top of "Richard".
2. De-hardcode the Today greeting and any remaining name/profile literals.
3. **In the same pass, make the PR2 decision** the strip-back explicitly deferred: for each of At Risk / People / Platforms / Logs, decide delete vs keep-hidden. Keep `Platforms` reachable somehow — a user must be able to connect an account — even if only as a minimal onboarding step.

**What NOT to build yet, and why.**
- **WhatsApp** (`feat/whatsapp-integration`) — adds a heavy dependency and a maintenance burden before the core is validated; breadth was deliberately parked.
- **The send-ripple animation / compact-workspace branches** — polish; they do not unblock learning.
- **Re-adding At Risk / People / the operator console** — that is the feature-heavy direction the strip-back deliberately reversed.
- **A hosted/multi-user version, auth, encryption** — premature until the local single-user product has validated demand.

**What evidence would prove it worked.**
- A person who is **not the author** completes setup, connects one platform, and the AI drafts a reply in *their* register — not the author's slang/emoji.
- 3–5 such users run it for a week, and you can run the first real structured feedback round (§17) against actual usage rather than assumption.
- Concretely measurable: AI drafts sent without heavy editing, threads cleared per session, and "did this sound like you?" answered yes by someone other than the author.

---

## 17. Suggested Updated Product Discovery Checklist

Rewritten against what the build already settles — generic discovery items already answered by the current product are dropped.

**Already answered (do not re-litigate).**
- [x] Stripped-back beats feature-heavy — decided and executed.
- [x] Core loop = Today → Inbox → Thread → Archived; operator console is not a user surface.
- [x] Sending stays user-triggered; no autonomous send.
- [x] LinkedIn leads; iMessage is the working second platform.
- [x] Automation volume must stay low for detection safety.
- [x] AI is the intelligence layer and must be disable-able.

**Needs validation (get real users / data).**
- [ ] Who liked the stripped-back version, and *what exactly* did they like? (Highest priority.)
- [ ] Will users trust and send AI-drafted replies? With how much editing?
- [ ] Is connecting an account acceptable friction, or where do users drop off?
- [ ] Does the product sound like *the user* once the voice is de-personalised?
- [ ] Is "inbox to clear" or "relationships to tend" the framing users respond to?
- [ ] Is local-on-your-Mac a selling point or tolerated friction?

**Needs technical decision.**
- [ ] How is the AI voice generated for a new user — onboarding sample, learned-from-history, or generic register?
- [ ] Local-only forever, packaged app, or hosted service? (Gates auth/encryption/multi-tenancy.)
- [ ] Refactor `index.ts` / `thread/[id]/page.tsx` before or after the next feature wave?
- [ ] What is the LinkedIn-UI-change contingency for scraping reliability?
- [ ] MVP platform scope — LinkedIn-only (cross-platform) or LinkedIn + iMessage (macOS-bound)?

**Future / not now.**
- [ ] WhatsApp and other platforms (`feat/whatsapp-integration` is ready when wanted).
- [ ] The People CRM / At Risk decay-triage surface.
- [ ] Conversation-starter / cold-outreach networking mode as a distinct pillar.
- [ ] Motion/animation polish (`feat/send-ripple`), collapsible workspace.
- [ ] Monetisation, accounts, hosted multi-user.

---

## 18. Paste-Ready Summary For ChatGPT

```
RELATIONSHIP INBOX OS — CURRENT STATE (for planning the next stage)

WHAT IT IS
A local-first desktop tool that pulls a person's unread direct messages from
multiple platforms (LinkedIn + iMessage working today; Instagram/TikTok beta;
WhatsApp is a stub) into ONE inbox, sorted by who has waited longest. For each
conversation an AI writes a summary, states what the other person wants, and
lists unanswered questions, so the user never rereads a cold thread. The user
then replies — by hand or with AI help — and clears the thread. It runs
entirely on the user's own machine (SQLite, no server, no accounts). It is a
working early-MVP: feature-complete for daily use and heavily engineered for
reliability, but single-user, local-only, version 0.1.0, not productised.

ORIGINAL vs STRIPPED-BACK
The earlier version was feature-heavy: 7 nav routes, a full operator/settings
console, operator actions in the top bar, aggressive scraping defaults, and a
relationship-CRM surface (At Risk + People pages). It was also built around the
author personally — the AI literally hardcodes his identity and texting voice.
A deliberate multi-PR "strip-back" narrowed the product to "the inbox loop":
4 routes (Today, Inbox, Archived, Settings), 4 settings, a read-only status
bar, and gentler automation. IMPORTANT NUANCE: the strip-back HID the extra
features from the UI — it did not delete the code — and it is unfinished: a
"PR2" to decide which hidden routes to delete is still pending.

MAIN FEATURES (current baseline)
Unified inbox + longest-wait sort; a "Today" hero showing the single most-
overdue thread with R/S/E keyboard actions; GREEN/AMBER/RED risk ageing; AI
thread summaries + "what they want" + open loops; AI suggested replies and
"compose-in-voice" (intent -> full message); shorten/warmer rewrites; outreach-
vs-genuine classification; snooze (with AI snooze timing); scheduled send;
bulk actions; archive. AI has real safeguards (hallucination guards, citation
checks, no autonomous send, honest empty-fallbacks) and runs on OpenAI/GLM/
Gemini.

USER FEEDBACK EVIDENCE
None is in the repository. No research notes, interviews, surveys, or issues.
The strip-back is the only artefact of feedback, and it documents WHAT changed,
never WHY a user asked for it. "A lot of people liked it" is not evidenced in
code — treat the size/nature of that reception as UNKNOWN. Capturing real user
feedback is the single biggest missing input for planning.

BRANCH / FEATURE INVENTORY (~70 branches)
Most feature branches are already merged into the baseline or superseded. The
only genuinely net-new work parked on branches: a full WhatsApp integration
(feat/whatsapp-integration — ready but heavy), a send animation/motion system,
a compact-workspace UI rework, and two specific hardening commits. A large
~73-commit branch is pre-strip-back history, not a feature. Nothing on a branch
is needed for the recommended next step. Treat branches as a future inventory,
not a backlog.

KEY UNANSWERED QUESTIONS
1. Who liked the stripped-back version and what exactly did they like?
2. How is the hardcoded author identity/voice replaced so it works for anyone?
3. Inbox-to-clear vs relationships-to-tend — which framing?
4. Local-only forever, packaged app, or hosted service? (Gates auth/security.)
5. Will users trust and send AI-drafted replies? Is connecting an account
   acceptable friction?
6. MVP scope — LinkedIn-only, or LinkedIn + iMessage (which ties it to macOS)?

RECOMMENDED NEXT STEP
Make the product work authentically for a SECOND person: replace the hardcoded
"Richard" AI voice/identity with a one-time voice setup (the Settings operator-
profile fields are the existing seam), de-hardcode the name/greeting, and in
the same pass make the deferred PR2 decision on the hidden routes (but keep a
way to connect an account). Do NOT build WhatsApp, animations, or re-add the
operator pages yet. Success = a non-author user connects a platform and the AI
drafts in THEIR voice; then 3-5 users run it for a week and produce the first
real feedback. This is the smallest change that unblocks all the user research
the project now needs.
```
