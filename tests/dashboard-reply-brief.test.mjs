import test from "node:test";
import assert from "node:assert/strict";

// Dashboard helpers ship as TypeScript; the test runner is invoked with
// `node --import tsx --test ...` from the root package.json so the .ts
// import below resolves at runtime.
const {
  chooseDisplayBrief,
  shouldShowChecklist,
  moreSectionHasContent,
  durableContextLabel,
  MORE_DISCLOSURE_LABEL
} = await import("../apps/dashboard/lib/reply-brief.ts");

// Small builder for the dashboard's ThreadResponse fixture — only the
// fields the brief helpers actually read.
function thread(partial = {}) {
  return {
    replyBrief: null,
    summary: "",
    whatTheyWant: "",
    openLoops: [],
    needsReply: false,
    messages: [],
    ...partial
  };
}

test("MORE_DISCLOSURE_LABEL exact wording from the spec", () => {
  // Issue #388 promoted the checklist to its own "Draft coverage" section,
  // so the disclosure label no longer advertises a checklist.
  assert.equal(MORE_DISCLOSURE_LABEL, "More context · nudge");
});

test("durableContextLabel returns the neutral 'Who they are' phrasing", () => {
  // The spec lists Who he is / Who she is / Who they are as options; we
  // default to neutral since the dashboard does not carry a pronoun
  // signal on Person rows.
  assert.equal(durableContextLabel(), "Who they are");
});

test("chooseDisplayBrief: server-provided brief passes through untouched", () => {
  const serverBrief = {
    where_it_stands: "Already-computed trace",
    on_you: "Acknowledge the offer",
    required_points: [],
    optional_followups: [],
    handled_points: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  const result = chooseDisplayBrief(thread({ replyBrief: serverBrief }));
  assert.equal(result, serverBrief);
});

test("chooseDisplayBrief: synthesises a no-pending brief for a quiet dormant thread", () => {
  const result = chooseDisplayBrief(
    thread({
      replyBrief: null,
      summary: "Brandon — old peer, last spoke six weeks ago.",
      whatTheyWant: "No clear ask yet.",
      openLoops: [],
      needsReply: false,
      messages: [{ direction: "IN", text: "All good, talk soon." }]
    })
  );
  assert.match(result.where_it_stands, /Brandon/);
  assert.match(result.on_you, /Nothing pending/i);
  assert.equal(result.required_points.length, 0);
});

test("chooseDisplayBrief: with one openLoop the required_points carry it through", () => {
  const result = chooseDisplayBrief(
    thread({
      summary: "Marianne — current project.",
      whatTheyWant: "She asked whether Friday at 11 still works.",
      openLoops: ["Confirm Friday at 11 works"],
      needsReply: true,
      messages: [{ direction: "IN", text: "Friday still good?" }]
    })
  );
  assert.equal(result.required_points.length, 1);
  assert.equal(result.required_points[0].text, "Confirm Friday at 11 works");
  // on_you carries the real ask, not the static "No clear ask yet." string.
  assert.match(result.on_you, /Friday/);
});

test("chooseDisplayBrief: falls back to the latest inbound when there's no summary", () => {
  const result = chooseDisplayBrief(
    thread({
      summary: "",
      whatTheyWant: "",
      needsReply: true,
      messages: [
        { direction: "OUT", text: "An old reply from me." },
        { direction: "IN", text: "thanks for the intro to Sarah, will reach out soon" }
      ]
    })
  );
  assert.match(result.where_it_stands, /intro to Sarah/);
});

test("chooseDisplayBrief: needsReply=true with no real ask produces the soft prompt", () => {
  const result = chooseDisplayBrief(
    thread({
      whatTheyWant: "No clear ask yet.",
      needsReply: true,
      messages: [{ direction: "IN", text: "👋" }]
    })
  );
  assert.match(result.on_you, /waiting on a reply|short acknowledgement/i);
  // Doesn't echo the static fallback string at the user.
  assert.equal(/No clear ask yet/i.test(result.on_you), false);
});

test("shouldShowChecklist: hidden by default with 0 required points and no dismissed loops", () => {
  assert.equal(
    shouldShowChecklist({ requiredPointsCount: 0, dismissedOpenLoopsCount: 0 }),
    false
  );
});

test("shouldShowChecklist: hidden by default for a single required point", () => {
  // Spec Step 8: 1 required → state in On you, no bulky checklist.
  assert.equal(
    shouldShowChecklist({ requiredPointsCount: 1, dismissedOpenLoopsCount: 0 }),
    false
  );
});

test("shouldShowChecklist: surfaces the checklist once 2+ required points exist", () => {
  assert.equal(
    shouldShowChecklist({ requiredPointsCount: 2, dismissedOpenLoopsCount: 0 }),
    true
  );
  assert.equal(
    shouldShowChecklist({ requiredPointsCount: 5, dismissedOpenLoopsCount: 0 }),
    true
  );
});

test("shouldShowChecklist: also surfaces when there's something to restore", () => {
  // Otherwise the dismissed-set is hidden behind the checklist and
  // there's no path to bring a loop back.
  assert.equal(
    shouldShowChecklist({ requiredPointsCount: 0, dismissedOpenLoopsCount: 1 }),
    true
  );
});

test("moreSectionHasContent: empty brief + 0 required + 0 dismissed → no More section", () => {
  const empty = {
    where_it_stands: "Quiet thread.",
    on_you: "Nothing pending.",
    required_points: [],
    optional_followups: [],
    handled_points: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  assert.equal(moreSectionHasContent(empty), false);
});

test("moreSectionHasContent: an optional follow-up alone is enough to surface More", () => {
  const briefWithOptional = {
    where_it_stands: "Quiet thread.",
    on_you: "Nothing pending.",
    required_points: [],
    optional_followups: [{ id: "ask", text: "Ask what he's looking at now", status: "optional" }],
    handled_points: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  assert.equal(moreSectionHasContent(briefWithOptional), true);
});

test("moreSectionHasContent: durable_context, tone_steer, fuller_context each surface More", () => {
  const base = {
    where_it_stands: "Trace.",
    on_you: "On you.",
    required_points: [],
    optional_followups: [],
    handled_points: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  for (const field of ["fuller_context", "durable_context", "tone_steer"]) {
    const brief = { ...base, [field]: "Some content" };
    assert.equal(
      moreSectionHasContent(brief),
      true,
      `expected More to surface when ${field} is set`
    );
  }
});

test("chooseDisplayBrief: synthesised fallback carries an empty they_said list", () => {
  // The dashboard panel renders the substance section only when
  // they_said has content. The fallback path (older rows without
  // replyBriefJson) must produce an empty array so the panel hides
  // the section calmly instead of throwing on .map() against undefined.
  const result = chooseDisplayBrief(
    thread({
      summary: "Old peer, last spoke six weeks ago.",
      needsReply: false,
      messages: [{ direction: "IN", text: "All good, talk soon." }]
    })
  );
  assert.deepEqual(result.they_said, []);
});

test("chooseDisplayBrief: server-provided brief's they_said passes through untouched", () => {
  const serverBrief = {
    where_it_stands: "You asked about exec search.",
    on_you: "Acknowledge the paused offer.",
    required_points: [],
    optional_followups: [],
    handled_points: [],
    they_said: [
      { id: "recruiter", text: "He explained recruiter / team CV pitching." },
      { id: "pause", text: "Paused the Middle East offer." }
    ],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  const result = chooseDisplayBrief(thread({ replyBrief: serverBrief }));
  assert.equal(result, serverBrief);
  assert.equal(result.they_said?.length, 2);
});

test("moreSectionHasContent: handled_points alone surface More so the operator can see what was dropped", () => {
  const brief = {
    where_it_stands: "Trace.",
    on_you: "Nothing pending.",
    required_points: [],
    optional_followups: [],
    handled_points: [{ id: "h", text: "Confirm Friday", status: "handled", reason: "you answered" }],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  assert.equal(moreSectionHasContent(brief), true);
});

test("moreSectionHasContent: required points alone no longer surface More (#388 promoted the checklist to its own Draft coverage section)", () => {
  // Before #388 the gated checklist lived inside More, so 2+ required
  // points would open the disclosure. Now the checklist is its own
  // top-level "Draft coverage" section, so required points must NOT pull
  // the disclosure open on their own — only genuinely secondary material
  // (optional follow-ups, context, tone, handled) does.
  const briefWithLoopsOnly = {
    where_it_stands: "Trace.",
    on_you: "Two things to answer.",
    required_points: [
      { id: "a", text: "Answer A", status: "required" },
      { id: "b", text: "Answer B", status: "required" }
    ],
    optional_followups: [],
    handled_points: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: true
  };
  assert.equal(moreSectionHasContent(briefWithLoopsOnly), false);
});
