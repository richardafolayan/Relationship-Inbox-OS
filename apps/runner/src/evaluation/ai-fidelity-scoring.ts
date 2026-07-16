import type { SummaryOutput, SuggestedRepliesOutput } from "@inbox-os/core";
import {
  deriveMechanicalWritingRules,
  validateMechanicalWritingRules
} from "../services/ai-output-rules";
import type {
  AiFidelityCase,
  AiFidelityCaseScore,
  AiFidelityDimensionScores,
  AiFidelityFailure,
  PatternAssertion
} from "./ai-fidelity-types";

const SCORE_KEYS: Array<keyof AiFidelityDimensionScores> = [
  "factualAccuracy",
  "hallucinations",
  "importantOmissions",
  "conversationState",
  "actionItemRecall",
  "replyCoverage",
  "suggestedReplyUsefulness",
  "userIdentityAccuracy",
  "voiceFidelity",
  "punctuationFormattingCompliance"
];

function normaliseScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function matches(text: string, pattern: string): boolean {
  return new RegExp(pattern, "iu").test(text);
}

function assertionMatches(text: string, assertion: PatternAssertion): boolean {
  return assertion.anyOf.some((pattern) => matches(text, pattern));
}

function percentage(passed: number, total: number): number {
  return total === 0 ? 100 : normaliseScore((passed / total) * 100);
}

function summaryText(output: SummaryOutput): string {
  const brief = output.reply_brief;
  return [
    output.summary,
    output.what_they_want,
    ...output.open_loops,
    ...output.remember.map((item) => `${item.note} ${item.date ?? ""}`),
    ...output.tone_notes,
    output.urgency_hint ?? "",
    brief?.where_it_stands ?? "",
    ...(brief?.they_said ?? []).map((point) => point.text),
    brief?.on_you ?? "",
    ...(brief?.required_points ?? []).flatMap((point) => [point.text, point.reason ?? ""]),
    ...(brief?.optional_followups ?? []).flatMap((point) => [point.text, point.reason ?? ""]),
    ...(brief?.handled_points ?? []).flatMap((point) => [point.text, point.reason ?? ""]),
    brief?.fuller_context ?? "",
    brief?.durable_context ?? "",
    brief?.tone_steer ?? ""
  ]
    .filter(Boolean)
    .join("\n");
}

function actionText(output: SummaryOutput): string {
  return [
    ...output.open_loops,
    ...(output.reply_brief?.required_points ?? []).map((point) => point.text)
  ].join("\n");
}

function addFailure(
  failures: AiFidelityFailure[],
  dimension: keyof AiFidelityDimensionScores,
  assertionId: string,
  detail: string
): void {
  failures.push({ dimension, assertionId, detail });
}

function scoreAbsentAssertions(
  text: string,
  assertions: PatternAssertion[],
  failures: AiFidelityFailure[],
  dimension: keyof AiFidelityDimensionScores
): number {
  let passed = 0;
  for (const assertion of assertions) {
    if (!assertionMatches(text, assertion)) {
      passed += 1;
    } else {
      addFailure(failures, dimension, assertion.id, assertion.rationale);
    }
  }
  return percentage(passed, assertions.length);
}

function scorePresentAssertions(
  text: string,
  assertions: PatternAssertion[],
  failures: AiFidelityFailure[],
  dimension: keyof AiFidelityDimensionScores
): number {
  let passed = 0;
  for (const assertion of assertions) {
    if (assertionMatches(text, assertion)) {
      passed += 1;
    } else {
      addFailure(failures, dimension, assertion.id, assertion.rationale);
    }
  }
  return percentage(passed, assertions.length);
}

export function scoreAiFidelityCase(
  fixture: AiFidelityCase,
  summary: SummaryOutput,
  suggestedReplies: SuggestedRepliesOutput
): AiFidelityCaseScore {
  const failures: AiFidelityFailure[] = [];
  const summaryCorpus = summaryText(summary);
  const actions = actionText(summary);
  const replies = suggestedReplies.replies.map((reply) => reply.text.trim()).filter(Boolean);
  const repliesCorpus = replies.join("\n");
  const allCorpus = `${summaryCorpus}\n${repliesCorpus}`;

  const factualAccuracy = scoreAbsentAssertions(
    allCorpus,
    fixture.expected.forbiddenFactualClaims,
    failures,
    "factualAccuracy"
  );

  const factualHallucinationScore = scoreAbsentAssertions(
    allCorpus,
    fixture.expected.forbiddenFactualClaims,
    failures,
    "hallucinations"
  );
  const actionHallucinationScore = scoreAbsentAssertions(
    actions,
    fixture.expected.forbiddenActionItems,
    failures,
    "hallucinations"
  );
  const hallucinations = normaliseScore(
    (factualHallucinationScore + actionHallucinationScore) / 2
  );

  const importantOmissions = scorePresentAssertions(
    summaryCorpus,
    fixture.expected.facts,
    failures,
    "importantOmissions"
  );

  const requiredCount = summary.reply_brief?.required_points.length ?? summary.open_loops.length;
  const stateChecks = [
    summary.needs_reply === fixture.expected.state.needsReply,
    requiredCount >= fixture.expected.state.minRequiredPoints,
    requiredCount <= fixture.expected.state.maxRequiredPoints,
    fixture.expected.state.uncertaintyAnyOf
      ? fixture.expected.state.uncertaintyAnyOf.some((pattern) => matches(allCorpus, pattern))
      : true
  ];
  if (!stateChecks[0]) {
    addFailure(failures, "conversationState", "needs-reply", `Expected needs_reply=${fixture.expected.state.needsReply}.`);
  }
  if (!stateChecks[1] || !stateChecks[2]) {
    addFailure(
      failures,
      "conversationState",
      "required-point-count",
      `Expected ${fixture.expected.state.minRequiredPoints}-${fixture.expected.state.maxRequiredPoints} required points, received ${requiredCount}.`
    );
  }
  if (!stateChecks[3]) {
    addFailure(failures, "conversationState", "preserve-uncertainty", "The output did not preserve the fixture's explicit uncertainty.");
  }
  const conversationState = percentage(stateChecks.filter(Boolean).length, stateChecks.length);

  const recalledActions = fixture.expected.actionItems.filter((assertion) => assertionMatches(actions, assertion));
  const forbiddenActionsAbsent = fixture.expected.forbiddenActionItems.filter(
    (assertion) => !assertionMatches(actions, assertion)
  );
  for (const assertion of fixture.expected.actionItems) {
    if (!assertionMatches(actions, assertion)) {
      addFailure(failures, "actionItemRecall", assertion.id, assertion.rationale);
    }
  }
  for (const assertion of fixture.expected.forbiddenActionItems) {
    if (assertionMatches(actions, assertion)) {
      addFailure(failures, "actionItemRecall", assertion.id, assertion.rationale);
    }
  }
  const actionItemRecall = percentage(
    recalledActions.length + forbiddenActionsAbsent.length,
    fixture.expected.actionItems.length + fixture.expected.forbiddenActionItems.length
  );

  const replyCoveragePerReply = replies.map((reply) => {
    const hits = fixture.expected.replyBeats.filter((assertion) => assertionMatches(reply, assertion)).length;
    return percentage(hits, fixture.expected.replyBeats.length);
  });
  const replyCoverage =
    replyCoveragePerReply.length === 0
      ? 0
      : normaliseScore(replyCoveragePerReply.reduce((sum, score) => sum + score, 0) / replyCoveragePerReply.length);
  fixture.expected.replyBeats.forEach((assertion) => {
    if (replies.length > 0 && replies.every((reply) => !assertionMatches(reply, assertion))) {
      addFailure(failures, "replyCoverage", assertion.id, assertion.rationale);
    }
  });

  const normalisedReplies = new Set(replies.map((reply) => reply.toLowerCase().replace(/\s+/g, " ")));
  const usefulnessChecks = [
    replies.length >= fixture.expected.minimumReplies,
    replies.every((reply) => reply.length > 0 && reply.length <= 280),
    replies.every((reply) => !/(?:as an ai|the operator|cannot generate|couldn['’]?t generate|write your reply)/iu.test(reply)),
    normalisedReplies.size === replies.length,
    replies.every((reply) =>
      fixture.expected.replyBeats.length === 0
        ? true
        : fixture.expected.replyBeats.some((assertion) => assertionMatches(reply, assertion))
    )
  ];
  usefulnessChecks.forEach((passed, index) => {
    if (!passed) {
      addFailure(
        failures,
        "suggestedReplyUsefulness",
        `usefulness-${index + 1}`,
        [
          "Too few sendable suggestions.",
          "A suggestion is empty or exceeds 280 characters.",
          "A suggestion contains model or operator meta-talk.",
          "Suggestions are not meaningfully distinct.",
          "A suggestion is not grounded in any expected reply beat."
        ][index]!
      );
    }
  });
  const suggestedReplyUsefulness = percentage(usefulnessChecks.filter(Boolean).length, usefulnessChecks.length);

  const userIdentityAccuracy = scoreAbsentAssertions(
    allCorpus,
    fixture.expected.identityForbidden,
    failures,
    "userIdentityAccuracy"
  );

  const mechanicalRules = deriveMechanicalWritingRules(fixture.operatorProfile);
  const mechanicalViolations = suggestedReplies.replies
    .map((reply) => ({
      replyLabel: reply.label,
      issues: validateMechanicalWritingRules(reply.text, mechanicalRules)
    }))
    .filter((entry) => entry.issues.length > 0);
  const avoidedPass = fixture.expected.voiceAvoided.every((pattern) => !matches(repliesCorpus, pattern));
  const preferredPass =
    fixture.expected.voicePreferredAnyOf.length === 0 ||
    fixture.expected.voicePreferredAnyOf.some((pattern) => matches(repliesCorpus, pattern));
  const voiceChecks = [mechanicalViolations.length === 0, avoidedPass, preferredPass];
  if (!voiceChecks[0]) addFailure(failures, "voiceFidelity", "mechanical-voice-rules", "One or more explicit mechanical voice rules were violated.");
  if (!voiceChecks[1]) addFailure(failures, "voiceFidelity", "avoided-phrase", "A phrase the user explicitly avoids appeared in a suggestion.");
  if (!voiceChecks[2]) addFailure(failures, "voiceFidelity", "preferred-voice", "None of the fixture's optional voice anchors appeared across the suggestions.");
  const voiceFidelity = percentage(voiceChecks.filter(Boolean).length, voiceChecks.length);

  const genericPunctuationViolations = suggestedReplies.replies.filter((reply) => /[—–;:]/u.test(reply.text));
  const formatChecks = [
    mechanicalViolations.length === 0,
    genericPunctuationViolations.length === 0,
    suggestedReplies.replies.every((reply) => ["A", "B", "C"].includes(reply.label)),
    new Set(suggestedReplies.replies.map((reply) => reply.label)).size === suggestedReplies.replies.length,
    suggestedReplies.replies.every((reply) => reply.text.length <= 280)
  ];
  if (!formatChecks[0]) addFailure(failures, "punctuationFormattingCompliance", "fixture-mechanical-rules", "Explicit punctuation rules were not satisfied.");
  if (!formatChecks[1]) addFailure(failures, "punctuationFormattingCompliance", "global-punctuation", "An em dash, en dash, semicolon or colon survived post-processing.");
  if (!formatChecks[2] || !formatChecks[3]) addFailure(failures, "punctuationFormattingCompliance", "reply-labels", "Reply labels must be unique A/B/C values.");
  if (!formatChecks[4]) addFailure(failures, "punctuationFormattingCompliance", "reply-length", "A reply exceeds 280 characters.");
  const punctuationFormattingCompliance = percentage(formatChecks.filter(Boolean).length, formatChecks.length);

  return {
    dimensions: {
      factualAccuracy,
      hallucinations,
      importantOmissions,
      conversationState,
      actionItemRecall,
      replyCoverage,
      suggestedReplyUsefulness,
      userIdentityAccuracy,
      voiceFidelity,
      punctuationFormattingCompliance
    },
    failures,
    mechanicalRules,
    mechanicalViolations
  };
}

export function averageDimensionScores(
  scores: AiFidelityDimensionScores[]
): AiFidelityDimensionScores {
  return Object.fromEntries(
    SCORE_KEYS.map((key) => [
      key,
      scores.length === 0
        ? 0
        : normaliseScore(scores.reduce((sum, score) => sum + score[key], 0) / scores.length)
    ])
  ) as unknown as AiFidelityDimensionScores;
}
