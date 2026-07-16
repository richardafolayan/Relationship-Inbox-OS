import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultSettings } from "@inbox-os/core";
import { runnerConfig, type AiProvider } from "../config";
import {
  createAiService,
  type AiProviderCallMetric
} from "../services/ai";
import type { OperatorProfile, SettingsStore } from "../types/runtime";
import {
  AI_FIDELITY_CASES,
  AI_FIDELITY_EVALUATION_NOW
} from "../evaluation/ai-fidelity-fixtures";
import {
  averageDimensionScores,
  scoreAiFidelityCase
} from "../evaluation/ai-fidelity-scoring";
import type {
  AiFidelityCaseResult,
  AiFidelityDimensionScores,
  AiFidelityOperationMetrics,
  AiFidelityProviderReport,
  AiFidelityReport,
  AiFidelityTag
} from "../evaluation/ai-fidelity-types";

type EvaluationProvider = Extract<AiProvider, "openai" | "gemini">;

interface CliOptions {
  providers: EvaluationProvider[];
  phase: string;
  outputPath: string | null;
  includeOutputs: boolean;
  caseIds: Set<string> | null;
}

interface PriceRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseProviders(raw: string | null): EvaluationProvider[] {
  const values = (raw ?? "gemini,openai")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const providers = values.filter(
    (value): value is EvaluationProvider => value === "openai" || value === "gemini"
  );
  if (providers.length !== values.length || providers.length === 0) {
    throw new Error("--providers must be a comma-separated subset of gemini,openai");
  }
  return [...new Set(providers)];
}

function parseOptions(): CliOptions {
  const caseArg = argumentValue("--case");
  return {
    providers: parseProviders(argumentValue("--providers")),
    phase: argumentValue("--phase")?.trim() || "ad-hoc",
    outputPath: argumentValue("--output"),
    includeOutputs: process.argv.includes("--include-outputs"),
    caseIds: caseArg
      ? new Set(caseArg.split(",").map((value) => value.trim()).filter(Boolean))
      : null
  };
}

function priceRate(providerId: EvaluationProvider): PriceRate | null {
  const prefix = providerId === "openai" ? "AI_EVAL_OPENAI" : "AI_EVAL_GEMINI";
  const input = Number(process.env[`${prefix}_INPUT_USD_PER_MILLION`]);
  const output = Number(process.env[`${prefix}_OUTPUT_USD_PER_MILLION`]);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
  return { inputUsdPerMillion: input, outputUsdPerMillion: output };
}

function sumNullable(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function estimateCost(metrics: AiProviderCallMetric[], rate: PriceRate | null): number | null {
  if (!rate) return null;
  const prompt = sumNullable(metrics.map((metric) => metric.promptTokens));
  const completion = sumNullable(metrics.map((metric) => metric.completionTokens));
  if (prompt === null || completion === null) return null;
  return (prompt * rate.inputUsdPerMillion + completion * rate.outputUsdPerMillion) / 1_000_000;
}

function operationMetrics(
  latencyMs: number,
  providerCalls: AiProviderCallMetric[],
  rate: PriceRate | null
): AiFidelityOperationMetrics {
  return {
    latencyMs: Math.round(latencyMs * 10) / 10,
    providerCalls,
    promptTokens: sumNullable(providerCalls.map((metric) => metric.promptTokens)),
    completionTokens: sumNullable(providerCalls.map((metric) => metric.completionTokens)),
    totalTokens: sumNullable(providerCalls.map((metric) => metric.totalTokens)),
    estimatedCostUsd: estimateCost(providerCalls, rate)
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1);
  return Math.round(ordered[index]! * 10) / 10;
}

function createEvaluationSettingsStore(
  providerId: EvaluationProvider,
  operatorProfile: OperatorProfile
): SettingsStore {
  return {
    getSettings: async () => ({
      ...defaultSettings,
      enabledPlatforms: [...defaultSettings.enabledPlatforms],
      aiProvider: providerId,
      geminiModel: providerId === "gemini" ? runnerConfig.geminiModel : undefined
    }),
    getOperatorProfile: async () => operatorProfile
  } as unknown as SettingsStore;
}

async function evaluateCase(
  providerId: EvaluationProvider,
  fixture: (typeof AI_FIDELITY_CASES)[number],
  includeOutputs: boolean,
  rate: PriceRate | null
): Promise<AiFidelityCaseResult> {
  let currentOperation: "summary" | "replies" = "summary";
  const metricBuckets: Record<"summary" | "replies", AiProviderCallMetric[]> = {
    summary: [],
    replies: []
  };
  const ai = createAiService(
    createEvaluationSettingsStore(providerId, fixture.operatorProfile),
    {
      forceProviderId: providerId,
      now: () => new Date(AI_FIDELITY_EVALUATION_NOW),
      onProviderCall: (metric) => metricBuckets[currentOperation].push(metric)
    }
  );

  const summaryStartedAt = performance.now();
  const summary = await ai.updateThreadSummary({
    displayName: fixture.displayName,
    previousSummary: fixture.previousSummary,
    previousOpenLoops: fixture.previousOpenLoops,
    previousRemember: [],
    messages: fixture.messages,
    needsReply: fixture.messages.at(-1)?.direction === "IN"
  });
  const summaryLatencyMs = performance.now() - summaryStartedAt;

  currentOperation = "replies";
  const latestInbound = [...fixture.messages].reverse().find((message) => message.direction === "IN");
  const latestOutbound = [...fixture.messages].reverse().find((message) => message.direction === "OUT");
  const repliesStartedAt = performance.now();
  const suggestedReplies = await ai.generateSuggestedReplies({
    displayName: fixture.displayName,
    summary: summary.summary,
    whatTheyWant: summary.what_they_want,
    openLoops: summary.open_loops,
    recentMessages: fixture.messages.slice(-8),
    needsReply: summary.needs_reply,
    platform: fixture.platform,
    category: "genuine",
    lastInboundAt: latestInbound?.timestamp ?? null,
    lastOutboundAt: latestOutbound?.timestamp ?? null,
    operatorProfile: fixture.operatorProfile,
    operatorStyle: fixture.operatorStyle ?? null,
    contactStyle: fixture.contactStyle ?? null,
    replyBrief: summary.reply_brief ?? null
  });
  const replyLatencyMs = performance.now() - repliesStartedAt;

  const allMetrics = [...metricBuckets.summary, ...metricBuckets.replies];
  const model = allMetrics.find((metric) => metric.status === "success")?.model ?? allMetrics[0]?.model ?? null;
  const summaryAvailable = summary.source?.providerId === providerId;
  const repliesAvailable = suggestedReplies.source?.providerId === providerId;
  const unavailableReason = !summaryAvailable
    ? summary.source?.fellBackMessage ?? "Summary provider produced no valid output."
    : !repliesAvailable
      ? suggestedReplies.source?.fellBackMessage ?? "Reply provider produced no valid output."
      : null;
  const result: AiFidelityCaseResult = {
    caseId: fixture.id,
    providerId,
    model,
    available: summaryAvailable && repliesAvailable,
    unavailableReason,
    score: summaryAvailable && repliesAvailable
      ? scoreAiFidelityCase(fixture, summary, suggestedReplies)
      : null,
    summaryMetrics: operationMetrics(summaryLatencyMs, metricBuckets.summary, rate),
    replyMetrics: operationMetrics(replyLatencyMs, metricBuckets.replies, rate)
  };
  if (includeOutputs) {
    result.output = { summary, suggestedReplies };
  }
  return result;
}

function providerReport(
  providerId: EvaluationProvider,
  cases: AiFidelityCaseResult[]
): AiFidelityProviderReport {
  const operationLatencies = cases.flatMap((result) => [
    result.summaryMetrics.latencyMs,
    result.replyMetrics.latencyMs
  ]);
  const totalLatency = operationLatencies.reduce((sum, value) => sum + value, 0);
  return {
    providerId,
    model: cases.find((result) => result.model)?.model ?? null,
    availableCaseCount: cases.filter((result) => result.available).length,
    unavailableCaseCount: cases.filter((result) => !result.available).length,
    dimensions: cases.some((result) => result.score)
      ? averageDimensionScores(
          cases.flatMap((result) => result.score ? [result.score.dimensions] : [])
        )
      : null,
    cases,
    latencyMs: {
      total: Math.round(totalLatency * 10) / 10,
      mean: operationLatencies.length === 0 ? 0 : Math.round((totalLatency / operationLatencies.length) * 10) / 10,
      p50: percentile(operationLatencies, 0.5),
      p95: percentile(operationLatencies, 0.95)
    },
    tokens: {
      prompt: sumNullable(cases.flatMap((result) => [result.summaryMetrics.promptTokens, result.replyMetrics.promptTokens])),
      completion: sumNullable(cases.flatMap((result) => [result.summaryMetrics.completionTokens, result.replyMetrics.completionTokens])),
      total: sumNullable(cases.flatMap((result) => [result.summaryMetrics.totalTokens, result.replyMetrics.totalTokens]))
    },
    estimatedCostUsd: sumNullable(
      cases.flatMap((result) => [result.summaryMetrics.estimatedCostUsd, result.replyMetrics.estimatedCostUsd])
    )
  };
}

function printProviderSummary(report: AiFidelityProviderReport): void {
  console.log(`\n${report.providerId}/${report.model ?? "unknown-model"}`);
  console.log(`  available cases: ${report.availableCaseCount}/${report.cases.length}`);
  if (report.dimensions) {
    for (const [dimension, score] of Object.entries(report.dimensions)) {
      console.log(`  ${dimension}: ${score}`);
    }
  } else {
    console.log("  quality scores: unavailable (no valid provider outputs)");
  }
  console.log(
    `  latency ms: mean=${report.latencyMs.mean} p50=${report.latencyMs.p50} p95=${report.latencyMs.p95}`
  );
  console.log(
    `  tokens: prompt=${report.tokens.prompt ?? "unavailable"} completion=${report.tokens.completion ?? "unavailable"} total=${report.tokens.total ?? "unavailable"}`
  );
  console.log(
    `  estimated cost USD: ${report.estimatedCostUsd === null ? "unavailable (set explicit AI_EVAL_* rates)" : report.estimatedCostUsd.toFixed(6)}`
  );
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (options.providers.includes("openai") && runnerConfig.openAiModel !== "gpt-5-nano") {
    throw new Error(
      `#808 requires GPT-5 Nano. OPENAI_MODEL resolved to ${runnerConfig.openAiModel}; set OPENAI_MODEL=gpt-5-nano.`
    );
  }
  const fixtures = options.caseIds
    ? AI_FIDELITY_CASES.filter((fixture) => options.caseIds!.has(fixture.id))
    : AI_FIDELITY_CASES;
  if (fixtures.length === 0) throw new Error("No evaluation cases matched --case.");

  const reports: AiFidelityProviderReport[] = [];
  for (const providerId of options.providers) {
    const results: AiFidelityCaseResult[] = [];
    const rate = priceRate(providerId);
    for (const [index, fixture] of fixtures.entries()) {
      console.log(`[ai-eval] ${providerId} ${index + 1}/${fixtures.length} ${fixture.id}`);
      results.push(await evaluateCase(providerId, fixture, options.includeOutputs, rate));
    }
    const report = providerReport(providerId, results);
    reports.push(report);
    printProviderSummary(report);
  }

  const tagsCovered = [...new Set(fixtures.flatMap((fixture) => fixture.tags))] as AiFidelityTag[];
  const report: AiFidelityReport = {
    schemaVersion: 1,
    phase: options.phase,
    generatedAt: new Date().toISOString(),
    caseCount: fixtures.length,
    tagsCovered,
    providers: reports,
    combined: {
      dimensions: reports.some((provider) => provider.dimensions)
        ? averageDimensionScores(
            reports.flatMap((provider) => provider.dimensions ? [provider.dimensions] : []) as AiFidelityDimensionScores[]
          )
        : null,
      estimatedCostUsd: sumNullable(reports.map((provider) => provider.estimatedCostUsd))
    }
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n[ai-eval] wrote ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(`[ai-eval] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
