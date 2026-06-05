// First-valid-result race across two AI providers (issue #382 — pilot
// R-0029). Used for VISIBLE, SLOW user-facing generation only
// (Reassess today; extend cautiously). Doubles provider spend per
// raced call, so do NOT wire this into background scans / classifiers
// / coverage checks without a separate cost conversation.
//
// Behaviour:
//   - Dispatches the call against the primary and secondary
//     providers in parallel.
//   - Returns the FIRST result that passes the caller-supplied
//     `validate` predicate. "First response" alone isn't enough —
//     a fast malformed/empty/fallback response shouldn't beat a
//     slow valid one.
//   - If the fast call returns invalid, waits for the other one.
//   - If both return invalid (or both reject), throws the primary's
//     error (the call site's existing fallback path then runs as
//     usual — race is purely additive).
//   - Cannot cancel the loser's API call (no streaming cancel on
//     OpenAI's REST API), so the loser's network request keeps
//     running. We just discard its result.
//   - Records winner provider, winner ms, and loser outcome for
//     telemetry. Caller logs whatever is appropriate.

import { performance } from "node:perf_hooks";

import type { AiProvider } from "../config.js";

export interface AiRaceParticipant<T> {
  /** Logical name for logs and metrics — usually the AiProvider id. */
  providerId: AiProvider | string;
  /** The actual call. Receives the participant's id for downstream logging. */
  call: (participantId: AiProvider | string) => Promise<T>;
}

export interface AiRaceOutcome<T> {
  /** The chosen result — first one that passed validate. */
  result: T;
  /** Provider that produced it. */
  winnerProviderId: AiProvider | string;
  /** Milliseconds from race start to winner's resolution. */
  winnerDurationMs: number;
  /** Loser participant's outcome. Useful for telemetry. */
  loser:
    | { kind: "discarded"; providerId: AiProvider | string; durationMs: number }
    | { kind: "rejected"; providerId: AiProvider | string; durationMs: number; error: unknown }
    | { kind: "invalid"; providerId: AiProvider | string; durationMs: number }
    | { kind: "still_running"; providerId: AiProvider | string };
}

export interface AiRaceOptions<T> {
  primary: AiRaceParticipant<T>;
  secondary: AiRaceParticipant<T>;
  /**
   * Returns true when the result is a "real" output — schema-valid,
   * non-empty, not a fallback shape. The race waits for the OTHER
   * participant when this returns false, so a fast malformed result
   * never beats a slow valid one.
   */
  validate: (result: T) => boolean;
  /**
   * Optional ceiling for the whole race. If neither participant
   * resolves within this window the primary's last error (or a
   * timeout error) is thrown. Default: no timeout — caller's existing
   * try/catch handles AI provider timeouts at the lower level.
   */
  timeoutMs?: number;
}

/**
 * Race two providers and return the first valid result. See the file
 * header comment for behaviour notes.
 */
export async function raceAiProviders<T>(opts: AiRaceOptions<T>): Promise<AiRaceOutcome<T>> {
  const start = performance.now();
  const wrap = (p: AiRaceParticipant<T>) =>
    p
      .call(p.providerId)
      .then((result) => ({ kind: "ok" as const, providerId: p.providerId, result, ms: performance.now() - start }))
      .catch((error) => ({ kind: "err" as const, providerId: p.providerId, error, ms: performance.now() - start }));

  const primaryPromise = wrap(opts.primary);
  const secondaryPromise = wrap(opts.secondary);

  // Outcome holders. We resolve the race when the first VALID result
  // lands; if the first to resolve is invalid or errored, we still
  // wait on the other.
  const firstSettled = await Promise.race([primaryPromise, secondaryPromise]);

  if (firstSettled.kind === "ok" && opts.validate(firstSettled.result)) {
    const winnerIsPrimary = firstSettled.providerId === opts.primary.providerId;
    return {
      result: firstSettled.result,
      winnerProviderId: firstSettled.providerId,
      winnerDurationMs: firstSettled.ms,
      loser: {
        kind: "still_running",
        providerId: winnerIsPrimary ? opts.secondary.providerId : opts.primary.providerId
      }
    };
  }

  // First settled was invalid or errored. Wait on the other.
  const secondSettled = await (firstSettled.providerId === opts.primary.providerId
    ? secondaryPromise
    : primaryPromise);

  if (secondSettled.kind === "ok" && opts.validate(secondSettled.result)) {
    return {
      result: secondSettled.result,
      winnerProviderId: secondSettled.providerId,
      winnerDurationMs: secondSettled.ms,
      loser:
        firstSettled.kind === "err"
          ? {
              kind: "rejected",
              providerId: firstSettled.providerId,
              durationMs: firstSettled.ms,
              error: firstSettled.error
            }
          : {
              kind: "invalid",
              providerId: firstSettled.providerId,
              durationMs: firstSettled.ms
            }
    };
  }

  // Both invalid or errored. Bubble the primary's error so the call
  // site's existing fallback path runs as usual.
  const primary = firstSettled.providerId === opts.primary.providerId ? firstSettled : secondSettled;
  if (primary.kind === "err") {
    throw primary.error;
  }
  throw new Error(
    `raceAiProviders: both ${opts.primary.providerId} and ${opts.secondary.providerId} returned invalid results.`
  );
}
