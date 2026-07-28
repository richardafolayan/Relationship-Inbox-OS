# Use Tovi

Tovi is a calm place to understand conversations and reply
in your own words. It does not send automatically.

## The daily loop

1. Open **Today** for the next conversation that needs attention.
2. Read the short context, where things stand, and what still needs addressing.
3. Open the thread and write the reply yourself.
4. Use optional writing help only when useful.
5. Press Send, or explicitly schedule the reply.
6. Mark handled, snooze, or move to the next conversation.

## Main pages

### Today

Today focuses on the next reply and shows a small view of what follows. It
uses reply state, snooze state, conversation age, favorites, and quiet-hour
rules. You can open the thread, snooze it, or mark it handled.

### Inbox

Inbox is the full active list. It supports search, platform and category
filters, favorites, ordering, selection, bulk mark-done, snooze, and rescan.
Archived and future-snoozed threads are not shown here. New inbound messages
clear snooze, while archived conversations stay archived until you restore them.

### Reconnect

Reconnect is a LinkedIn-only list of dormant conversations worth considering.
It helps you choose whom to contact; it never sends a catch-up automatically.

### Settings

Settings contains the deliberately small pilot controls:

- iMessage and LinkedIn setup, plus WhatsApp QR setup when enabled;
- auto-scan and quiet-hour behavior;
- your identity, preferred tone, common and avoided phrases, interests, and
  AI help level;
- Focus Reply Buffer templates and audience;
- optional notifications and overdue digest;
- app update checks;
- pilot feedback and bug reporting.

## Thread workspace

The thread page combines:

- chronological messages with older-message pagination;
- audio, image, file, link-preview, reaction, reply, poll, and group metadata
  when the platform supplies them;
- a reply brief with the current state and required, optional, and handled
  points;
- open-loop checkboxes and durable things to remember;
- relationship memory from other conversations with the same person;
- an editable composer and saved draft;
- explicit send, scheduled send, update schedule, cancel, and retry controls;
- archive, snooze, reminder, mark-done, rescan, and open-on-platform actions.

Platform capability matters. LinkedIn is text-first but supports verified
send, reaction, and outbound edit. iMessage supports text and file/voice
attachments. WhatsApp supports rich media and polls when the opt-in adapter is
connected. Instagram and TikTok remain beta.

## AI help levels

Choose the amount of help in Settings:

- **Memory only** keeps summaries, context, and what to address, while hiding
  drafting features. Some organizational classifiers are also reduced.
- **Writing support** is the default. It adds transformations such as shorter
  or warmer to text you wrote.
- **Full drafts** adds complete suggestions and compose-from-intent. It is
  opt-in.

AI output stays editable and sending stays a separate user action. The exact
provider and voice rules are documented in the
[AI developer reference](../developer/ai.md).

## Focus Reply Buffer

A focus window lets you prepare a close-contact and a professional
acknowledgement in your own words for a period such as a lecture or deep-work
block. The app can show which covered contacts messaged during the window and
offer the right note. You still press Send for every acknowledgement. The
default audience is favorites, and the one-note-per-person setting prevents
repeated suggestions in the same window.

## Dictation, voice notes, and transcription

The microphone control is user-triggered. On an iPhone, open Tovi from the
private HTTPS phone link so Safari or the Home Screen app can use that iPhone's
microphone. Tap Dictate, tap Stop, edit the raw transcript, then choose Keep as
transcript or Turn into messages. Formatted messages remain editable and
nothing sends until you choose a Send action.

An HTTP phone link cannot access browser microphone capture. Tovi labels that
state Dictation unavailable and points back to the HTTPS setup in Settings. It
does not treat keyboard dictation as the Tovi recording and transcription
flow. Depending on the action, recorded audio becomes composer dictation or an
attachment. Captured platform audio and video can be transcribed by the
configured local or OpenAI provider.

## Notifications and quiet hours

Notifications are optional. While the app is visible, new messages can use a
calm in-app toast; while hidden, granted desktop notifications can be used.
The notification center keeps a local list. Quiet hours suppress attention
noise and the dashboard's auto-scan window avoids continuous background work.

## Search and keyboard access

Press Command-K or use Search to find people, threads, destinations, and scan
actions. Escape returns from a thread. The sidebar can collapse on desktop and
a bottom dock replaces it at phone widths.

## Archive, snooze, and reminders

- Mark done records the conversation as handled for the active reply loop.
- Archive removes it from active lists. Open Archived through Search or the
  Inbox link to restore it.
- Snooze hides it until the chosen time. A new inbound can resurface it early.
- A reminder adds private context for why the thread was snoozed. It is never
  sent to the contact.

## Feedback and privacy

Feedback sends only what you type, safe application context, and a screenshot
you deliberately attach and confirm. Private message content is not added to a
report automatically. Review screenshots before sending.

AI prompts may include the relevant local conversation and stored transcript.
Use AI only with a provider and messages you are comfortable sending to that
provider. Local transcription keeps audio on the Mac; OpenAI transcription
sends the selected media to OpenAI.

For a complete status map, including hidden operator and demo routes, see the
[current feature inventory](../developer/features.md).
