import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AI_FIDELITY_CASES
} from "../apps/runner/dist/evaluation/ai-fidelity-fixtures.js";
import {
  scoreAiFidelityCase
} from "../apps/runner/dist/evaluation/ai-fidelity-scoring.js";
import {
  AI_FIDELITY_TAGS
} from "../apps/runner/dist/evaluation/ai-fidelity-types.js";
import {
  deriveMechanicalWritingRules,
  repairMechanicalWritingRules,
  validateMechanicalWritingRules
} from "../apps/runner/dist/services/ai-output-rules.js";
import {
  AMBIGUITY_DISCIPLINE,
  enforceConfiguredWritingRules
} from "../apps/runner/dist/services/ai.js";
import {
  hasUnspecifiedAmbiguousOutcome,
  preserveAmbiguousEvidence
} from "../apps/runner/dist/services/ai-ambiguity.js";

test("AI fidelity fixtures cover every required #808 category", () => {
  const covered = new Set(AI_FIDELITY_CASES.flatMap((fixture) => fixture.tags));
  assert.deepEqual([...AI_FIDELITY_TAGS].filter((tag) => !covered.has(tag)), []);
});

test("AI fidelity fixtures use distinct synthetic identities", () => {
  assert.equal(new Set(AI_FIDELITY_CASES.map((fixture) => fixture.operatorProfile.displayName)).size, AI_FIDELITY_CASES.length);
  assert.equal(new Set(AI_FIDELITY_CASES.map((fixture) => fixture.displayName)).size, AI_FIDELITY_CASES.length);
});

test("mechanical writing rules detect and repair lowercase, full-stop and emoji violations", () => {
  const fixture = AI_FIDELITY_CASES.find((candidate) => candidate.id === "casual-lowercase-no-stops");
  assert.ok(fixture);
  const rules = deriveMechanicalWritingRules(fixture.operatorProfile);
  assert.deepEqual(rules, {
    forbidFullStops: true,
    forbidExclamationMarks: false,
    forbidQuestionMarks: false,
    forbidEmoji: true,
    allLowercase: true
  });
  assert.deepEqual(validateMechanicalWritingRules("Yhh. South exit 👍", rules), [
    "full_stop",
    "emoji",
    "uppercase"
  ]);
  const repaired = repairMechanicalWritingRules("Yhh. South exit 👍", rules);
  assert.equal(repaired, "yhh south exit");
  assert.deepEqual(validateMechanicalWritingRules(repaired, rules), []);
});

test("mechanical writing rules derive formal no-exclamation constraints independently", () => {
  const fixture = AI_FIDELITY_CASES.find((candidate) => candidate.id === "formal-source-table-no-exclamation");
  assert.ok(fixture);
  const rules = deriveMechanicalWritingRules(fixture.operatorProfile);
  assert.equal(rules.forbidExclamationMarks, true);
  assert.equal(rules.forbidEmoji, true);
  assert.equal(rules.forbidFullStops, false);
  assert.equal(rules.allLowercase, false);
});

test("configured mechanical rules repair actual generated-reply text", () => {
  const fixture = AI_FIDELITY_CASES.find((candidate) => candidate.id === "casual-lowercase-no-stops");
  assert.ok(fixture);
  assert.equal(
    enforceConfiguredWritingRules("Sweet. South exit 👍", fixture.operatorProfile),
    "sweet south exit"
  );
});

test("ambiguity discipline is wired into both summary and suggested-reply prompts", () => {
  assert.match(AMBIGUITY_DISCIPLINE, /Preserve uncertainty/);
  assert.match(AMBIGUITY_DISCIPLINE, /Do not resolve an unnamed 'it'/);
  assert.match(AMBIGUITY_DISCIPLINE, /Do not turn 'not sure yet'/);
  const aiJsPath = fileURLToPath(new URL("../apps/runner/dist/services/ai.js", import.meta.url));
  const source = readFileSync(aiJsPath, "utf8");
  assert.ok(source.split("AMBIGUITY_DISCIPLINE").length - 1 >= 3);
  assert.match(source, /EACH suggested reply must engage with EVERY reply-relevant beat/);
  assert.match(source, /complete alternatives, not partial fragments/);
});

test("only unsupported RESOLVED outcomes are deterministically replaced for ambiguous threads", () => {
  const ambiguous = [
    { direction: "OUT", text: "How did it go?", timestamp: "2026-07-10T08:00:00.000Z" },
    { direction: "IN", text: "Not sure yet, they said they'll let me know soon", timestamp: "2026-07-10T08:20:00.000Z" }
  ];
  assert.equal(hasUnspecifiedAmbiguousOutcome(ambiguous), true);
  // A domain-noun paraphrase is preserved. Deterministic replacement is
  // reserved for invented resolved outcomes; domain inference is handled by
  // the prompt-side ambiguity discipline.
  assert.equal(
    preserveAmbiguousEvidence(
      "They are waiting to hear about a recent application.",
      ambiguous,
      "They are waiting to hear back, and the outcome is still uncertain."
    ),
    "They are waiting to hear about a recent application."
  );
  assert.equal(
    preserveAmbiguousEvidence("Looks like they passed.", ambiguous, "Outcome still uncertain."),
    "Outcome still uncertain."
  );

  const explicit = [
    { direction: "IN", text: "Not sure about the application yet, they'll let me know soon", timestamp: "2026-07-10T08:20:00.000Z" }
  ];
  assert.equal(hasUnspecifiedAmbiguousOutcome(explicit), false);
  assert.equal(
    preserveAmbiguousEvidence("The application outcome is uncertain.", explicit, "fallback"),
    "The application outcome is uncertain."
  );
});

test("a reply-request 'let me know' never arms the ambiguity guard", () => {
  const invite = [
    { direction: "IN", text: "Are you free Saturday? Let me know", timestamp: "2026-07-10T09:00:00.000Z" }
  ];
  assert.equal(hasUnspecifiedAmbiguousOutcome(invite), false);
  assert.equal(
    preserveAmbiguousEvidence(
      "They invited you to an event on Saturday and want an answer.",
      invite,
      "They are not sure of the outcome yet."
    ),
    "They invited you to an event on Saturday and want an answer."
  );
});

test("punctuation bans require worded rule statements, not punctuation characters", () => {
  const noRules = {
    forbidFullStops: false,
    forbidExclamationMarks: false,
    forbidQuestionMarks: false,
    forbidEmoji: false,
    allLowercase: false
  };
  const cases = [
    { about: "I never use jargon! Keep things warm and direct.", avoidedPhrases: "" },
    { about: "I do not like small talk, ok? Straight to the point.", avoidedPhrases: "" },
    { about: "friendly, casual", avoidedPhrases: "no worries!" }
  ];
  for (const profile of cases) {
    assert.deepEqual(deriveMechanicalWritingRules(profile), noRules, JSON.stringify(profile));
  }
  assert.deepEqual(
    deriveMechanicalWritingRules({ about: "Never use exclamation marks or question marks.", avoidedPhrases: "" }),
    { ...noRules, forbidExclamationMarks: true, forbidQuestionMarks: true }
  );
});

test("both user-facing reply generators run deterministic configured-rule repair", () => {
  const aiJsPath = fileURLToPath(new URL("../apps/runner/dist/services/ai.js", import.meta.url));
  const source = readFileSync(aiJsPath, "utf8");
  assert.ok(source.split("enforceConfiguredWritingRules").length - 1 >= 3);
  assert.ok(source.split("mechanicalWritingRulesPromptFragment").length - 1 >= 3);
});

test("pre-written short-case expectations produce a defined perfect score", () => {
  const fixture = AI_FIDELITY_CASES.find((candidate) => candidate.id === "short-scheduling-two-asks");
  assert.ok(fixture);
  const summary = {
    summary: "Mina asked for the lab notes and proposed 3pm tomorrow.",
    what_they_want: "Mina wants you to send the lab notes today and confirm whether 3pm tomorrow works.",
    open_loops: ["Send the lab notes", "Confirm whether 3pm tomorrow works"],
    remember: [],
    tone_notes: [],
    needs_reply: true,
    reply_brief: {
      where_it_stands: "Mina asked for the lab notes and proposed 3pm tomorrow.",
      they_said: [
        { id: "notes", text: "Mina asked for the lab notes today." },
        { id: "time", text: "Mina asked whether 3pm tomorrow works." }
      ],
      on_you: "Send the notes and answer whether 3pm works.",
      required_points: [
        { id: "send-notes", text: "Send the lab notes", status: "required" },
        { id: "confirm-time", text: "Confirm whether 3pm tomorrow works", status: "required" }
      ],
      optional_followups: [],
      handled_points: [],
      enough_to_reply_without_scrolling: true
    }
  };
  const suggestedReplies = {
    replies: [
      { label: "A", intent: "Confirm both", text: "I'll send the notes today, and 3pm tomorrow works for me" },
      { label: "B", intent: "Send and confirm", text: "Yep, I'll share the notes today and can do 3pm tomorrow" },
      { label: "C", intent: "Clear confirmation", text: "I'll send the lab notes over today, 3pm tomorrow works" }
    ],
    needs_user_input: []
  };
  const score = scoreAiFidelityCase(fixture, summary, suggestedReplies);
  assert.deepEqual(score.dimensions, {
    factualAccuracy: 100,
    hallucinations: 100,
    importantOmissions: 100,
    conversationState: 100,
    actionItemRecall: 100,
    replyCoverage: 100,
    suggestedReplyUsefulness: 100,
    userIdentityAccuracy: 100,
    voiceFidelity: 100,
    punctuationFormattingCompliance: 100
  });
  assert.deepEqual(score.failures, []);
});
