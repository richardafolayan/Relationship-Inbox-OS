# Product

## Register

product

## Users

The operator: one person trying to stay genuinely close to people across LinkedIn,
iMessage, Instagram, and TikTok. They are not running a sales pipeline. They are a
student, a founder, a friend, someone whose relationships matter and whose unread
threads quietly pile up.

Their context when they sit down with this tool is usually: tired, a little behind,
holding three half-remembered conversations in their head, and slightly guilty about
the people they haven't replied to. They have a narrow window (an evening, a commute)
and want to leave it having replied *well* to the people who matter, not just cleared
a number.

The job they are trying to get done: **understand each conversation quickly, then
reply in their own voice, thoughtfully, without rereading everything.** Triage is the
means; a real reply is the end.

## Product Purpose

Tovi (formerly Relationship Inbox OS) reduces the friction between "I should reply to them" and "I have
replied to them, properly." It does three things, in order:

1. **Surfaces who needs you and why** — a calm, ranked queue (Today) instead of an
   undifferentiated backlog.
2. **Rebuilds the context you've lost** — for any thread, it says what the other person
   is really asking, why (given the prior conversation), what still needs addressing,
   and what you've already covered, so you don't have to scroll back and reconstruct it.
3. **Helps you write your reply, in your words** — open loops to answer, a draft-coverage
   checklist, optional rewrites and AI drafts that stay opt-in and never send themselves.

Success is not "inbox zero." Success is the operator replying thoughtfully to the people
who matter, faster and with less dread, and trusting that nothing important slipped.

Everything runs locally on the operator's machine. There are no platform APIs in v1; it
drives a real browser. The product is being prepared for a small 3–5 person pilot. It is
deliberately low-surface-area: a calm place to reply, not a CRM, analytics console, lead
tool, or AI ghostwriter.

## Brand Personality

**Calm, warm, attentive.**

- **Calm.** It never shouts. Urgency is communicated through quiet rank and one small
  warm count next to Today (how many still need a reply, capped at 99+; pilot R-0089
  asked for the number back), never red badges or alarm. The operator should feel
  settled, not chased.
- **Warm.** These are relationships, not tickets. The voice is plain and human ("Reply
  to Maya", "You're caught up", "Nothing else needs you tonight"), never corporate
  ("0 items in queue", "Task completed").
- **Attentive.** It has clearly read the conversation so the operator doesn't have to.
  It surfaces the one thing that matters and gets out of the way.

It speaks the operator's language, sentence-case and conversational. It does not use
marketing buzzwords, em/en dashes in UI copy, or dot/pipe separators on the Today
surface. The operator's own voice lives only in their local profile; the product never
hardcodes a persona.

## Anti-references

- **Generic SaaS dashboards.** No KPI hero-metric tiles, no "5 cards in a grid" home
  screen, no analytics-console feel. This is not a place to measure throughput.
- **CRM / sales tools** (the Salesforce/HubSpot/pipeline family). No lead scoring,
  stages, deal value, or relationship "health scores." People are not records.
- **AI-slop startup template aesthetics.** No purple/violet gradients, no glassmorphism
  as decoration, no neon, no gratuitous icons, no nested cards, no tiny tracked-uppercase
  eyebrow above every section as scaffolding.
- **The notification-anxiety inbox** (aggressive unread counts, red dots everywhere,
  "you have 47 unread"). Volume is downplayed on purpose.
- **AI ghostwriter tools that replace the user's voice.** Full AI drafts are optional and
  never the default; sending is always user-triggered.

## Design Principles

1. **Clarity before decoration.** Every screen earns its keep by making the next reply
   easier. If an element doesn't help the operator understand or respond, it doesn't ship.
2. **Summarise, don't re-paste.** Prefer "what they're really asking" and "what still
   needs addressing" over reprinting raw message text. The operator should rarely need to
   reread the full thread.
3. **Progressive disclosure.** Show the essentials by default (what they said, why it
   matters, what's open); keep depth (fuller context, tone steer, already-covered) one
   quiet disclosure away.
4. **Keep the operator writing.** AI is reading support and scaffolding first. It explains
   and checks coverage; it drafts only when asked, and never sends.
5. **Calm over urgent.** Communicate priority through rank, spacing, and a single warm
   accent — not through alarm. Low surface area is a feature.

## Accessibility & Inclusion

- Target WCAG AA: body text ≥ 4.5:1, large/secondary text ≥ 3:1. Muted "ink" greys must
  stay legible on the warm paper background, not drift into decoration.
- Never encode meaning by color alone. Risk is always carried by a text label
  (Overdue / Waiting / Fresh) alongside the dot.
- Honour `prefers-reduced-motion` (already global): animations and transitions collapse
  to instant.
- Primary actions must be keyboard-reachable with visible focus states; the thread and
  Today surfaces support keyboard shortcuts for power use without hiding the visible path.
- Calm, plain language reduces cognitive load for tired and first-time operators alike.
