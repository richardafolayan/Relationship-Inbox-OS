import test from "node:test";
import assert from "node:assert/strict";
import {
  alreadyHeardSinceInbound,
  arrivedDuringFocus,
  coverageForRow,
  DEFAULT_ACK_TEMPLATES,
  DEFAULT_FOCUS_SETTINGS,
  EMPTY_FOCUS_WINDOW,
  endsAtIsoFromTime,
  fillNote,
  firstNameOf,
  focusAckExclusion,
  focusRailIdleLine,
  formatUntil,
  isFocusAckCandidate,
  isFocusActive,
  looksLikePhoneOrEmail,
  noteForRow,
  readAckTemplates,
  readFocusSettings,
  readFocusWindow,
  resyncNoteUntilLabel,
  rollsToTomorrow,
  tierForRow
} from "../apps/dashboard/lib/focus.ts";

// Fixed clock so the "during focus" / "replied today" windows are stable.
const NOW = new Date("2026-06-07T11:00:00.000Z");

const baseWindow = (over = {}) => ({
  active: true,
  startedAt: "2026-06-07T09:00:00.000Z",
  endsAt: "2026-06-07T17:30:00.000Z",
  reason: "deep work",
  note: "",
  audience: "favourites",
  windowId: "w1",
  ackedPersonIds: [],
  ...over
});

const settings = (over = {}) => ({ ...DEFAULT_FOCUS_SETTINGS, ...over });

const row = (over = {}) => ({
  personId: "p1",
  personName: "Mum",
  personFavourite: true,
  platform: "IMESSAGE",
  needsReply: true,
  lastInboundAt: "2026-06-07T10:00:00.000Z",
  lastOutboundAt: null,
  category: null,
  personBirthday: null,
  ...over
});

// ─────────────────────────── coverage + tier ───────────────────────────

test("favourite iMessage contact is covered at the close tier", () => {
  const result = coverageForRow(row(), "favourites");
  assert.equal(result.covered, true);
  assert.equal(result.tier, "close");
});

test("favourite LinkedIn contact is covered at the professional tier", () => {
  const result = coverageForRow(row({ platform: "LINKEDIN" }), "favourites");
  assert.equal(result.covered, true);
  assert.equal(result.tier, "professional");
  assert.equal(tierForRow(row({ platform: "LINKEDIN" })), "professional");
});

test("LinkedIn is never covered unless favourited, even with 'all personal'", () => {
  const r = row({ platform: "LINKEDIN", personFavourite: false, personName: "Ceri Jones" });
  assert.equal(coverageForRow(r, "favourites").covered, false);
  assert.equal(coverageForRow(r, "all_personal").covered, false);
});

test("an unknown phone number is excluded (favourites and all personal)", () => {
  const r = row({ personFavourite: false, personName: "+447418342917", personBirthday: null });
  assert.equal(coverageForRow(r, "favourites").covered, false);
  assert.equal(coverageForRow(r, "all_personal").covered, false);
});

test("an email-only handle is excluded under all personal", () => {
  const r = row({ personFavourite: false, personName: "fanda93203254@ypje.com" });
  assert.equal(coverageForRow(r, "all_personal").covered, false);
});

test("'all personal' widens to a named non-favourite iMessage contact", () => {
  const r = row({ personFavourite: false, personName: "Tobi" });
  assert.equal(coverageForRow(r, "favourites").covered, false);
  assert.equal(coverageForRow(r, "all_personal").covered, true);
});

test("'all personal' covers an iMessage handle that has a synced birthday", () => {
  const r = row({ personFavourite: false, personName: "+447900000000", personBirthday: "06-09" });
  assert.equal(coverageForRow(r, "all_personal").covered, true);
});

test("outreach / business threads are never covered, even when favourited", () => {
  const r = row({ category: "outreach" });
  assert.equal(coverageForRow(r, "favourites").covered, false);
  assert.equal(coverageForRow(r, "all_personal").covered, false);
});

// ─────────────────────────── timing predicates ───────────────────────────

test("arrivedDuringFocus is true only for inbound after the window start", () => {
  assert.equal(arrivedDuringFocus(row(), baseWindow(), NOW), true);
  assert.equal(
    arrivedDuringFocus(row({ lastInboundAt: "2026-06-07T08:00:00.000Z" }), baseWindow(), NOW),
    false
  );
  assert.equal(arrivedDuringFocus(row(), baseWindow({ active: false }), NOW), false);
  assert.equal(arrivedDuringFocus(row({ lastInboundAt: null }), baseWindow(), NOW), false);
});

test("alreadyHeardSinceInbound is about conversation order, not the calendar", () => {
  // Replied AFTER their latest message: they've heard from you. Suppress.
  assert.equal(
    alreadyHeardSinceInbound(
      row({ lastInboundAt: "2026-06-07T10:00:00.000Z", lastOutboundAt: "2026-06-07T10:30:00.000Z" })
    ),
    true
  );
  // Replied BEFORE their latest message (mid-conversation, they wrote back,
  // now they're waiting): NOT suppressed, even though the reply was minutes
  // ago on the same day. This is the pilot's Marianne case.
  assert.equal(
    alreadyHeardSinceInbound(
      row({ lastInboundAt: "2026-06-07T10:00:00.000Z", lastOutboundAt: "2026-06-07T09:59:00.000Z" })
    ),
    false
  );
  assert.equal(alreadyHeardSinceInbound(row({ lastOutboundAt: null })), false);
  assert.equal(alreadyHeardSinceInbound(row({ lastInboundAt: null, lastOutboundAt: "2026-06-07T10:30:00.000Z" })), false);
});

// ─────────────────────────── the single candidate gate ───────────────────────────

test("a covered, freshly-arrived, unanswered thread is a candidate", () => {
  assert.equal(isFocusAckCandidate(row(), baseWindow(), settings(), { now: NOW }), true);
});

test("quiet hours never suppress an active window's offers", () => {
  // An explicitly started focus window IS the operator asking for these
  // offers (a 2am "going to sleep" window exists to acknowledge night
  // messages), and nothing sends without a tap. The old quietHoursActive
  // flag is gone from the gate; passing it must change nothing.
  assert.equal(
    isFocusAckCandidate(row(), baseWindow(), settings(), { now: NOW, quietHoursActive: true }),
    true
  );
});

test("one note per person: an already-acked person is not a candidate", () => {
  const window = baseWindow({ ackedPersonIds: ["p1"] });
  assert.equal(isFocusAckCandidate(row(), window, settings(), { now: NOW }), false);
  // ...unless the operator turned the one-note rule off.
  assert.equal(
    isFocusAckCandidate(row(), window, settings({ oneNotePerPerson: false }), { now: NOW }),
    true
  );
});

test("a contact you answered after their latest message is not a candidate", () => {
  // lastOut (10:30) >= lastIn (10:00): they've heard from you. Skip.
  const r = row({ lastOutboundAt: "2026-06-07T10:30:00.000Z" });
  assert.equal(isFocusAckCandidate(r, baseWindow(), settings(), { now: NOW }), false);
});

test("a reply earlier today does NOT suppress someone who messaged after it", () => {
  // The pilot's Marianne case: replied at 09:58, she wrote back at 10:00
  // during the window, she is waiting. The old calendar-day rule hid her.
  const r = row({
    lastOutboundAt: "2026-06-07T09:58:00.000Z",
    lastInboundAt: "2026-06-07T10:00:00.000Z"
  });
  assert.equal(isFocusAckCandidate(r, baseWindow(), settings(), { now: NOW }), true);
});

test("a handled thread (needsReply false) is never a candidate", () => {
  assert.equal(
    isFocusAckCandidate(row({ needsReply: false }), baseWindow(), settings(), { now: NOW }),
    false
  );
});

test("no candidates when the window is inactive", () => {
  assert.equal(
    isFocusAckCandidate(row(), baseWindow({ active: false }), settings(), { now: NOW }),
    false
  );
});

// ─────────────────────────── note substitution (no AI) ───────────────────────────

test("fillNote substitutes only the three tokens", () => {
  const out = fillNote("Yo [Name], back at [until] ([reason]).", {
    name: "Tobi",
    until: "5:30pm",
    reason: "deep work"
  });
  assert.equal(out, "Yo Tobi, back at 5:30pm (deep work).");
});

test("noteForRow picks the tier template and fills name + until", () => {
  const window = baseWindow();
  // formatUntil renders in local time, so derive the expected label rather
  // than hardcoding it (keeps the test timezone-independent).
  const until = formatUntil(window.endsAt);
  assert.ok(until.length > 0);
  const close = noteForRow(row({ personName: "Tobi" }), window, DEFAULT_ACK_TEMPLATES);
  assert.match(close, /^Yo Tobi,/);
  assert.ok(close.includes(until), `close note should include "${until}"`);
  const prof = noteForRow(
    row({ personName: "Ceri Jones", platform: "LINKEDIN" }),
    window,
    DEFAULT_ACK_TEMPLATES
  );
  assert.match(prof, /^Hey Ceri,/);
});

test("firstNameOf and looksLikePhoneOrEmail behave", () => {
  assert.equal(firstNameOf("Madre Mum"), "Madre");
  assert.equal(firstNameOf(""), "there");
  assert.equal(looksLikePhoneOrEmail("+447418342917"), true);
  assert.equal(looksLikePhoneOrEmail("a@b.com"), true);
  assert.equal(looksLikePhoneOrEmail("Tobi"), false);
});

test("formatUntil and endsAtIsoFromTime round-trip a wall-clock time", () => {
  const iso = endsAtIsoFromTime("17:30", new Date("2026-06-07T11:00:00"));
  assert.equal(formatUntil(iso), "5:30pm");
  assert.equal(formatUntil(""), "");
  // A time already passed today rolls to tomorrow.
  const rolled = endsAtIsoFromTime("06:00", new Date("2026-06-07T11:00:00"));
  assert.equal(new Date(rolled).getDate(), 8);
});

// ─────────────────────────── backwards compatibility ───────────────────────────

test("readers fall back to defaults for a profile that predates the feature", () => {
  const legacy = {
    displayName: "Richard",
    about: "",
    interests: "",
    commonPhrases: "",
    avoidedPhrases: "",
    preferredStyle: "",
    aiHelpLevel: "writing_support",
    setupCompletedAt: "2026-01-01T00:00:00.000Z"
  };
  assert.deepEqual(readFocusWindow(legacy), EMPTY_FOCUS_WINDOW);
  assert.deepEqual(readFocusSettings(legacy), DEFAULT_FOCUS_SETTINGS);
  assert.deepEqual(readAckTemplates(legacy), DEFAULT_ACK_TEMPLATES);
  assert.deepEqual(readFocusWindow(null), EMPTY_FOCUS_WINDOW);
});

// ─────────────────────────── no auto-send invariant ───────────────────────────

test("the pure focus module never sends — it only decides and formats", async () => {
  const focus = await import("../apps/dashboard/lib/focus.ts");
  const exportNames = Object.keys(focus);
  // No send/post/fetch machinery lives in the pure helpers; the only send
  // path is the explicit sendAcknowledgement() in use-focus-window, fired by
  // a user click. Guard against a future refactor smuggling a sender in here.
  for (const name of exportNames) {
    assert.ok(
      !/send|post|fetch|dispatch/i.test(name),
      `lib/focus.ts must stay pure; unexpected export "${name}"`
    );
  }
  // Deciding a candidate is true must not throw or mutate its inputs.
  const window = baseWindow();
  const before = JSON.stringify(window);
  isFocusAckCandidate(row(), window, settings(), { now: NOW });
  assert.equal(JSON.stringify(window), before);
});

// ─────────────────────────── expiry: the window must actually end ───────────────────────────
// Regression for the pilot report "I set it as 8:31pm and it is still on":
// liveness derives from the clock, never from the stored flag alone.

test("isFocusActive flips false the moment endsAt passes", () => {
  const window = baseWindow(); // ends 17:30Z
  assert.equal(isFocusActive(window, new Date("2026-06-07T17:29:59.000Z")), true);
  assert.equal(isFocusActive(window, new Date("2026-06-07T17:30:00.000Z")), false);
  assert.equal(isFocusActive(window, new Date("2026-06-08T09:00:00.000Z")), false);
  assert.equal(isFocusActive(window, NOW), true);
});

test("a window without a parseable endsAt only ends manually", () => {
  assert.equal(isFocusActive(baseWindow({ endsAt: "" }), NOW), true);
  assert.equal(isFocusActive(baseWindow({ endsAt: "not-a-date" }), NOW), true);
  assert.equal(isFocusActive(baseWindow({ endsAt: "", active: false }), NOW), false);
  assert.equal(isFocusActive(null, NOW), false);
});

test("an expired window stops offering acknowledgements entirely", () => {
  const afterEnd = new Date("2026-06-07T17:31:00.000Z");
  // The same thread IS a candidate while the window runs...
  assert.equal(isFocusAckCandidate(row(), baseWindow(), settings(), { now: NOW }), true);
  // ...and stops being one the moment the window lapses — a note promising
  // "till 5:30pm" must never be offered at 5:31pm.
  assert.equal(isFocusAckCandidate(row(), baseWindow(), settings(), { now: afterEnd }), false);
  assert.equal(arrivedDuringFocus(row(), baseWindow(), afterEnd), false);
});

// ─────────────────────────── the operator's window note is what gets sent ───────────────────────────
// Regression: the setup sheet saved the edited note to focusWindow.note but
// every send path formatted from the saved templates, silently ignoring it.

test("noteForRow prefers the operator's window note for close contacts", () => {
  const window = baseWindow({
    note: "On the bike till [until], will text back properly after, [Name]!"
  });
  const until = formatUntil(window.endsAt);
  const out = noteForRow(row({ personName: "Tobi Ade" }), window, DEFAULT_ACK_TEMPLATES);
  assert.equal(out, `On the bike till ${until}, will text back properly after, Tobi!`);
});

test("professional contacts keep the calmer saved template, not the window note", () => {
  const window = baseWindow({ note: "On the bike till [until]!" });
  const out = noteForRow(
    row({ personName: "Ceri Jones", platform: "LINKEDIN" }),
    window,
    DEFAULT_ACK_TEMPLATES
  );
  assert.match(out, /^Hey Ceri,/);
  assert.equal(out.includes("bike"), false);
});

test("a per-window professional note overrides the professional template", () => {
  const window = baseWindow({
    note: "On the bike till [until]!",
    professionalNote: "Hi [Name], heads-down until [until], I'll come back to this properly after."
  });
  const until = formatUntil(window.endsAt);
  const out = noteForRow(
    row({ personName: "Ceri Jones", platform: "LINKEDIN" }),
    window,
    DEFAULT_ACK_TEMPLATES
  );
  assert.equal(out, `Hi Ceri, heads-down until ${until}, I'll come back to this properly after.`);
  // Close contacts still read the close note, not the professional one.
  const close = noteForRow(row({ personName: "Tobi" }), window, DEFAULT_ACK_TEMPLATES);
  assert.equal(close, `On the bike till ${until}!`);
});

test("a blank or absent professional note falls back to the professional template", () => {
  const blank = baseWindow({ professionalNote: "   " });
  const absent = baseWindow(); // field omitted entirely (older runner payload)
  delete absent.professionalNote;
  for (const window of [blank, absent]) {
    const out = noteForRow(
      row({ personName: "Ceri Jones", platform: "LINKEDIN" }),
      window,
      DEFAULT_ACK_TEMPLATES
    );
    assert.match(out, /^Hey Ceri,/);
  }
});

test("a blank window note falls back to the close template", () => {
  const out = noteForRow(row({ personName: "Tobi" }), baseWindow({ note: "   " }), DEFAULT_ACK_TEMPLATES);
  assert.match(out, /^Yo Tobi,/);
});

test("a window note with the time already substituted passes through unchanged", () => {
  const window = baseWindow({ note: "Heads down till 6:30pm, yours at 7 x" });
  const out = noteForRow(row({ personName: "Tobi" }), window, DEFAULT_ACK_TEMPLATES);
  assert.equal(out, "Heads down till 6:30pm, yours at 7 x");
});

// ─────────────────────────── until-label resync on time edits ───────────────────────────

test("resyncNoteUntilLabel swaps every stale label occurrence and nothing else", () => {
  assert.equal(
    resyncNoteUntilLabel("Back at 8:31pm. If urgent before 8:31pm, call.", "8:31pm", "9:15pm"),
    "Back at 9:15pm. If urgent before 9:15pm, call."
  );
});

test("resyncNoteUntilLabel is a no-op when the old label is absent, blank or unchanged", () => {
  assert.equal(resyncNoteUntilLabel("Back later tonight.", "8:31pm", "9:15pm"), "Back later tonight.");
  assert.equal(resyncNoteUntilLabel("Back at 8:31pm.", "8:31pm", "8:31pm"), "Back at 8:31pm.");
  assert.equal(resyncNoteUntilLabel("", "8:31pm", "9:15pm"), "");
  assert.equal(resyncNoteUntilLabel("Back at 8:31pm.", "", "9:15pm"), "Back at 8:31pm.");
});

// ─────────────────────────── exclusion reasons (review sheet honesty) ───────────────────────────
// Filtered contacts must be explainable, never silently absent: the sheet
// lists during-window waiting people with WHY no note is on offer.

test("focusAckExclusion names the gate that excluded each row", () => {
  // Actionable.
  assert.equal(focusAckExclusion(row(), baseWindow(), settings(), { now: NOW }), "candidate");
  // Window inactive, expired, or their message predates it.
  assert.equal(
    focusAckExclusion(row(), baseWindow({ active: false }), settings(), { now: NOW }),
    "not_during"
  );
  assert.equal(
    focusAckExclusion(row(), baseWindow(), settings(), { now: new Date("2026-06-07T18:00:00.000Z") }),
    "not_during"
  );
  assert.equal(
    focusAckExclusion(row({ lastInboundAt: "2026-06-07T08:00:00.000Z" }), baseWindow(), settings(), { now: NOW }),
    "not_during"
  );
  // Nothing waiting on the operator.
  assert.equal(
    focusAckExclusion(row({ needsReply: false }), baseWindow(), settings(), { now: NOW }),
    "handled"
  );
  // They've heard from you since their message.
  assert.equal(
    focusAckExclusion(row({ lastOutboundAt: "2026-06-07T10:30:00.000Z" }), baseWindow(), settings(), { now: NOW }),
    "already_heard"
  );
  // Outside the window's audience.
  assert.equal(
    focusAckExclusion(row({ personFavourite: false, personName: "+447418342917" }), baseWindow(), settings(), { now: NOW }),
    "not_covered"
  );
  // Got their one note this window...
  assert.equal(
    focusAckExclusion(row(), baseWindow({ ackedPersonIds: ["p1"] }), settings(), { now: NOW }),
    "already_acked"
  );
  // ...unless the one-note rule is off.
  assert.equal(
    focusAckExclusion(row(), baseWindow({ ackedPersonIds: ["p1"] }), settings({ oneNotePerPerson: false }), { now: NOW }),
    "candidate"
  );
});

test("focusRailIdleLine only claims everyone knows once someone was actually acknowledged", () => {
  assert.match(focusRailIdleLine(baseWindow()), /No quick notes waiting right now/);
  assert.match(
    focusRailIdleLine(baseWindow({ ackedPersonIds: ["p1"] })),
    /Everyone who messaged knows you've seen them/
  );
});

// ─────────────────────────── tomorrow rollover is said out loud ───────────────────────────

test("rollsToTomorrow flags a picker time that already passed today", () => {
  // Local wall-clock now (no Z), matching how the picker + helper work.
  const atElevenLocal = new Date("2026-06-07T11:00:00");
  assert.equal(rollsToTomorrow("06:00", atElevenLocal), true);
  // Exactly "now" rolls forward too (endsAtIsoFromTime uses <=).
  assert.equal(rollsToTomorrow("11:00", atElevenLocal), true);
  assert.equal(rollsToTomorrow("17:30", atElevenLocal), false);
  assert.equal(rollsToTomorrow("", atElevenLocal), false);
});
