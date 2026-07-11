import type { PlatformName, SummaryOutput, SuggestedRepliesOutput } from "@inbox-os/core";
import type { MessageForPrompt, OperatorProfile, StyleProfile } from "../types/runtime";
import type { MechanicalWritingRules } from "../services/ai-output-rules";
import type { AiProviderCallMetric } from "../services/ai";

export const AI_FIDELITY_TAGS = [
  "short_conversation",
  "long_conversation",
  "multi_topic",
  "ambiguous",
  "emotional",
  "interruptions",
  "old_context",
  "new_replies",
  "unresolved_promises",
  "already_answered_points",
  "action_items",
  "different_user_voice_rules",
  "strict_punctuation_rules"
] as const;

export type AiFidelityTag = (typeof AI_FIDELITY_TAGS)[number];

export interface PatternAssertion {
  id: string;
  anyOf: string[];
  rationale: string;
}

export interface AiFidelityExpected {
  state: {
    needsReply: boolean;
    minRequiredPoints: number;
    maxRequiredPoints: number;
    uncertaintyAnyOf?: string[];
  };
  facts: PatternAssertion[];
  forbiddenFactualClaims: PatternAssertion[];
  actionItems: PatternAssertion[];
  forbiddenActionItems: PatternAssertion[];
  replyBeats: PatternAssertion[];
  identityForbidden: PatternAssertion[];
  voicePreferredAnyOf: string[];
  voiceAvoided: string[];
  minimumReplies: number;
}

export interface AiFidelityCase {
  id: string;
  title: string;
  tags: AiFidelityTag[];
  platform: PlatformName;
  displayName: string;
  previousSummary?: string;
  previousOpenLoops: string[];
  messages: MessageForPrompt[];
  operatorProfile: OperatorProfile;
  operatorStyle?: StyleProfile | null;
  contactStyle?: StyleProfile | null;
  expected: AiFidelityExpected;
  rubric: string[];
}

export interface AiFidelityDimensionScores {
  factualAccuracy: number;
  hallucinations: number;
  importantOmissions: number;
  conversationState: number;
  actionItemRecall: number;
  replyCoverage: number;
  suggestedReplyUsefulness: number;
  userIdentityAccuracy: number;
  voiceFidelity: number;
  punctuationFormattingCompliance: number;
}

export interface AiFidelityFailure {
  dimension: keyof AiFidelityDimensionScores;
  assertionId: string;
  detail: string;
}

export interface AiFidelityCaseScore {
  dimensions: AiFidelityDimensionScores;
  failures: AiFidelityFailure[];
  mechanicalRules: MechanicalWritingRules;
  mechanicalViolations: Array<{ replyLabel: string; issues: string[] }>;
}

export interface AiFidelityOperationMetrics {
  latencyMs: number;
  providerCalls: AiProviderCallMetric[];
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
}

export interface AiFidelityCaseResult {
  caseId: string;
  providerId: "openai" | "gemini";
  model: string | null;
  available: boolean;
  unavailableReason: string | null;
  score: AiFidelityCaseScore | null;
  summaryMetrics: AiFidelityOperationMetrics;
  replyMetrics: AiFidelityOperationMetrics;
  output?: {
    summary: SummaryOutput;
    suggestedReplies: SuggestedRepliesOutput;
  };
}

export interface AiFidelityProviderReport {
  providerId: "openai" | "gemini";
  model: string | null;
  availableCaseCount: number;
  unavailableCaseCount: number;
  dimensions: AiFidelityDimensionScores | null;
  cases: AiFidelityCaseResult[];
  latencyMs: { total: number; mean: number; p50: number; p95: number };
  tokens: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
  };
  estimatedCostUsd: number | null;
}

export interface AiFidelityReport {
  schemaVersion: 1;
  phase: string;
  generatedAt: string;
  caseCount: number;
  tagsCovered: AiFidelityTag[];
  providers: AiFidelityProviderReport[];
  combined: {
    dimensions: AiFidelityDimensionScores | null;
    estimatedCostUsd: number | null;
  };
}
