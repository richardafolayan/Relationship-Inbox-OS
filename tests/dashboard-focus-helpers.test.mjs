import test from "node:test";
import assert from "node:assert/strict";
import {
  arrivedDuringFocus,
  coverageForRow,
  DEFAULT_ACK_TEMPLATES,
  DEFAULT_FOCUS_SETTINGS,
  EMPTY_FOCUS_WINDOW,
  endsAtIsoFromTime,
  fillNote,
  firstNameOf,
  formatUntil,
  hasRepliedToday,
  isFocusAckCandidate,
  looksLikePhoneOrEmail,
  noteForRow,
  readAckTemplates,
  readFocusSettings,
  readFocusWindow,
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

test("hasRepliedToday reflects an outbound on the same local day", () => {
  assert.equal(hasRepliedToday(row({ lastOutboundAt: "2026-06-07T10:30:00.000Z" }), NOW), true);
  assert.equal(hasRepliedToday(row({ lastOutboundAt: "2026-06-06T10:30:00.000Z" }), NOW), false);
  assert.equal(hasRepliedToday(row({ lastOutboundAt: null }), NOW), false);
});

// ─────────────────────────── the single candidate gate ───────────────────────────

test("a covered, freshly-arrived, unanswered thread is a candidate", () => {
  assert.equal(isFocusAckCandidate(row(), baseWindow(), settings(), { now: NOW }), true);
});

test("quiet hours suppress all acknowledgement offers", () => {
  assert.equal(
    isFocusAckCandidate(row(), baseWindow(), settings(), { now: NOW, quietHoursActive: true }),
    false
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

test("skip anyone already replied to today", () => {
  const r = row({ lastOutboundAt: "2026-06-07T10:30:00.000Z" });
  assert.equal(isFocusAckCandidate(r, baseWindow(), settings(), { now: NOW }), false);
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
