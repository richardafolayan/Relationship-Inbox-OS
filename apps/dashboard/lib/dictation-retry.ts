// #462 follow-up: classify a dictation transcription response into one of a
// few operator-facing outcomes. Pure + side-effect-free so the thread page
// stays thin and the decision (which failures keep the recorded clip for a
// one-tap retry vs. which are surfaced as a plain error) is unit-tested.
//
// The recorded audio is never persisted server-side — the "retry" outcome
// simply tells the page to keep the already-prepared WAV in memory so the
// operator doesn't have to speak again after a transient failure.

/** Shape of the runner's /control/transcribe-dictation JSON body. */
export interface DictationResponseBody {
  ok?: boolean;
  text?: string;
  reason?: "unavailable" | "no_speech" | "invalid_audio" | "skipped" | "failed" | string;
  error?: string;
}

export type DictationOutcome =
  /** Transcript came back — append `text` to the composer. */
  | { kind: "text"; text: string }
  /** Succeeded but no speech was detected. */
  | { kind: "empty" }
  /** Transient failure — keep the clip and offer a retry with `message`. */
  | { kind: "retry"; message: string }
  /** Permanent failure — show `message`; retrying the same clip won't help. */
  | { kind: "error"; message: string };

/** Shown when the request never completed (fetch threw — no response). */
export const DICTATION_LOST_CONNECTION_MESSAGE =
  "Lost connection to the transcription service. Your recording is still here. Try again.";

/** Shown when the runner replied with a 5xx / non-JSON (transport) failure. */
export const DICTATION_TRANSPORT_MESSAGE =
  "Couldn't reach the transcription service. Your recording is still here. Try again.";

/** Fallback when the runner declines but gives no usable reason. */
export const DICTATION_GENERIC_ERROR_MESSAGE = "Could not transcribe the recording.";

/**
 * Decide what to do with a *completed* dictation response.
 *
 * - 2xx with `ok:true` + non-empty text → append it.
 * - 2xx with `ok:true` + empty text → "no speech".
 * - A 5xx other than 503 (e.g. a runner-side timeout/command failure), or any
 *   body without an `error` field (i.e. a non-JSON proxy/server response) →
 *   transient: keep the clip and offer a retry. The dashboard proxies
 *   `/runner/*` through Next.js, so a dev-server recompile stall or a runner
 *   restart surfaces here as a non-JSON body — exactly the case where the same
 *   audio transcribes fine on a second attempt.
 * - 503 with a reason (transcription not configured) → a plain error; the
 *   same audio would fail the same way until the runner is reconfigured.
 * - Otherwise (a 4xx with a specific reason, e.g. no speech / bad audio) → a
 *   plain error; retrying the same clip would just fail the same way.
 */
export function classifyDictationResponse(input: {
  ok: boolean;
  status: number;
  data: DictationResponseBody;
}): DictationOutcome {
  const { ok, status, data } = input;
  if (ok && data.ok) {
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text ? { kind: "text", text } : { kind: "empty" };
  }
  const permanentReasons = new Set(["unavailable", "no_speech", "invalid_audio", "skipped"]);
  if (data.reason && permanentReasons.has(data.reason)) {
    return { kind: "error", message: data.error || DICTATION_GENERIC_ERROR_MESSAGE };
  }
  const transientStatus =
    status === 408 ||
    status === 409 ||
    status === 423 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
  const transient = transientStatus || !data.error;
  if (transient) {
    return { kind: "retry", message: DICTATION_TRANSPORT_MESSAGE };
  }
  return { kind: "error", message: data.error || DICTATION_GENERIC_ERROR_MESSAGE };
}
