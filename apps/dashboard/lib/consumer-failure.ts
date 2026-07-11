export type ConsumerFailureCode =
  | "RUNNER_OFFLINE"
  | "PARTIAL_STARTUP"
  | "ACTION_UNCERTAIN"
  | "DELIVERY_UNCERTAIN"
  | "PERMISSION_REQUIRED"
  | "CREDENTIALS_REQUIRED"
  | "NOT_FOUND"
  | "MALFORMED_DATA"
  | "DATABASE_UNAVAILABLE"
  | "SCAN_FAILED"
  | "SEND_NOT_ACCEPTED"
  | "AI_UNAVAILABLE"
  | "TRANSCRIPTION_FAILED"
  | "UPDATE_FAILED"
  | "INTEGRATION_UNAVAILABLE"
  | "UNEXPECTED";

export interface ConsumerFailure {
  code: ConsumerFailureCode;
  title: string;
  message: string;
  nextAction: string;
  actionLabel?: string;
  actionHref?: string;
  retrySafe: boolean;
  dataUncertain: boolean;
  deliveryUncertain: boolean;
}

export interface ConsumerFailureContext {
  path?: string;
  method?: string;
  status?: number;
  phase?: "network" | "response" | "parse" | "runtime" | "startup";
  diagnostic?: string;
}

function failure(
  input: Omit<ConsumerFailure, "dataUncertain" | "deliveryUncertain"> &
    Partial<Pick<ConsumerFailure, "dataUncertain" | "deliveryUncertain">>
): ConsumerFailure {
  return {
    ...input,
    dataUncertain: input.dataUncertain ?? false,
    deliveryUncertain: input.deliveryUncertain ?? false
  };
}

function diagnosticText(error: unknown, context: ConsumerFailureContext): string {
  const value =
    context.diagnostic ??
    (error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : "");
  return value.toLowerCase();
}

function isSendPath(path: string): boolean {
  return /\/(send|send-poll|retry-send|update-send|cancel-send)(?:\/|$|\?)/.test(path);
}

function isAiPath(path: string): boolean {
  return /(compose|ask|reassess|predraft|suggest|voice-profile|refresh-scores)/.test(path);
}

export function classifyConsumerFailure(
  error: unknown,
  context: ConsumerFailureContext = {}
): ConsumerFailure {
  if (
    error &&
    typeof error === "object" &&
    "failure" in error &&
    (error as { failure?: ConsumerFailure }).failure
  ) {
    return (error as { failure: ConsumerFailure }).failure;
  }

  const path = context.path?.toLowerCase() ?? "";
  const method = context.method?.toUpperCase() ?? "GET";
  const status = context.status;
  const diagnostic = diagnosticText(error, context);
  const networkFailure =
    context.phase === "network" ||
    /failed to fetch|fetch failed|networkerror|network request failed|econnrefused|socket hang up/.test(
      diagnostic
    );

  if (context.phase === "startup") {
    return failure({
      code: "PARTIAL_STARTUP",
      title: "Your conversations are not available yet.",
      message: "The app started, but its local data service did not finish opening.",
      nextAction: "Choose Try again. If this continues, reopen Relationship Inbox OS.",
      actionLabel: "Try again",
      retrySafe: true,
      dataUncertain: true
    });
  }

  if (networkFailure && isSendPath(path) && method !== "GET") {
    return failure({
      code: "DELIVERY_UNCERTAIN",
      title: "We could not confirm whether this sent.",
      message: "The connection ended before the app received a delivery result.",
      nextAction: "Check the conversation before trying again. Re-sending now could create a duplicate.",
      actionLabel: "Check delivery",
      retrySafe: false,
      deliveryUncertain: true
    });
  }

  if (networkFailure && method !== "GET") {
    return failure({
      code: "ACTION_UNCERTAIN",
      title: "We could not confirm that change.",
      message: "The connection ended before the app received a result.",
      nextAction: "Check whether the change was applied before trying again.",
      actionLabel: "Check again",
      retrySafe: false,
      dataUncertain: true
    });
  }

  if (networkFailure) {
    return failure({
      code: "RUNNER_OFFLINE",
      title: "Relationship Inbox OS is reconnecting.",
      message: "The local helper is not responding, so replies and sending are paused.",
      nextAction: "Choose Start runner. If it does not reconnect, reopen Relationship Inbox OS.",
      actionLabel: "Start runner",
      retrySafe: true
    });
  }

  if (context.phase === "parse" || /unexpected token|invalid json|malformed/.test(diagnostic)) {
    return failure({
      code: "MALFORMED_DATA",
      title: "This information could not be opened safely.",
      message: "The app received data in a format it does not recognise.",
      nextAction: "Reload once. If it happens again, send a report from Help.",
      actionLabel: "Reload",
      retrySafe: true,
      dataUncertain: true
    });
  }

  if (
    status === 403 ||
    /full disk access|permission|notallowederror|microphone access|cannot open chat\.db|authorization denied/.test(
      diagnostic
    )
  ) {
    return failure({
      code: "PERMISSION_REQUIRED",
      title: "Relationship Inbox OS needs permission to continue.",
      message: "macOS or your browser is blocking access needed for this action.",
      nextAction: "Open Settings, grant the requested access, then try again.",
      actionLabel: "Open Settings",
      actionHref: "/settings#platforms",
      retrySafe: true
    });
  }

  if (
    status === 401 ||
    /api[_ -]?key|credential|unauthori[sz]ed|auth required|login required|sign in required/.test(
      diagnostic
    )
  ) {
    const ai = isAiPath(path) || /openai|gemini|glm|ai provider/.test(diagnostic);
    return failure({
      code: "CREDENTIALS_REQUIRED",
      title: ai ? "AI is not connected yet." : "This account needs reconnecting.",
      message: ai
        ? "The app cannot use AI until a valid provider key is saved. Your conversation was not changed."
        : "The integration session has expired or is missing.",
      nextAction: ai
        ? "Open Settings, add a valid AI key, then try again."
        : "Open Settings and reconnect the account before retrying.",
      actionLabel: "Open Settings",
      actionHref: "/settings",
      retrySafe: true
    });
  }

  if (status === 404 || /not found|missing_(thread|message|person)|thread_not_found/.test(diagnostic)) {
    return failure({
      code: "NOT_FOUND",
      title: "This item is no longer here.",
      message: "It may have moved, been removed, or come from an older link.",
      nextAction: "Return to Today and open the conversation again from the current list.",
      actionLabel: "Back to Today",
      actionHref: "/today",
      retrySafe: false
    });
  }

  if (/sqlite|prisma|database|db unavailable|unable to open database|disk i\/o/.test(diagnostic)) {
    return failure({
      code: "DATABASE_UNAVAILABLE",
      title: "Your local inbox data could not be opened.",
      message: "Relationship Inbox OS has paused changes to avoid making the problem worse.",
      nextAction: "Reopen the app. If this continues, use Help to send a diagnostics-only report.",
      actionLabel: "Reopen app",
      retrySafe: false,
      dataUncertain: true
    });
  }

  if (path.includes("transcrib") || /transcription|whisper|no speech/.test(diagnostic)) {
    return failure({
      code: "TRANSCRIPTION_FAILED",
      title: "That recording was not transcribed.",
      message: "Your recording is still available in the composer.",
      nextAction: "Try the recording again, or type the reply instead.",
      actionLabel: "Try again",
      retrySafe: true
    });
  }

  if (path.includes("update")) {
    return failure({
      code: "UPDATE_FAILED",
      title: "The update did not start.",
      message: "The current app remains installed and your local data was not changed.",
      nextAction: "Check for updates again. If it still fails, reopen Relationship Inbox OS.",
      actionLabel: "Check again",
      retrySafe: true
    });
  }

  if (isAiPath(path) || /openai|gemini|glm|ai unavailable|model provider/.test(diagnostic)) {
    return failure({
      code: "AI_UNAVAILABLE",
      title: "AI could not help just now.",
      message: "Your conversation and your draft were not changed.",
      nextAction: "Keep writing in your own words, or try AI again later.",
      actionLabel: "Try again",
      retrySafe: true
    });
  }

  if (path.includes("scan") || /scan failed|selector mismatch/.test(diagnostic)) {
    return failure({
      code: "SCAN_FAILED",
      title: "The app could not check for new replies.",
      message: "Your existing conversations are unchanged, but the inbox may be out of date.",
      nextAction: "Reconnect the affected account, then run Scan now again.",
      actionLabel: "Open Settings",
      actionHref: "/settings#platforms",
      retrySafe: true,
      dataUncertain: true
    });
  }

  if (isSendPath(path)) {
    return failure({
      code: "SEND_NOT_ACCEPTED",
      title: "This message was not accepted for sending.",
      message: "The app received a definite failure before it could confirm the send.",
      nextAction: "Follow the recovery step shown for the account, then retry once.",
      actionLabel: "Try again",
      retrySafe: true
    });
  }

  if (
    path.includes("platform") ||
    path.includes("whatsapp") ||
    /integration|adapter|profile locked|selector/.test(diagnostic)
  ) {
    return failure({
      code: "INTEGRATION_UNAVAILABLE",
      title: "This account is not ready.",
      message: "Relationship Inbox OS cannot reach the connected service safely.",
      nextAction: "Open Settings and reconnect the account before trying again.",
      actionLabel: "Open Settings",
      actionHref: "/settings#platforms",
      retrySafe: true
    });
  }

  return failure({
    code: "UNEXPECTED",
    title: "Something unexpected interrupted the app.",
    message: "The app stopped this part of the task instead of guessing that it worked.",
    nextAction: "Reload once. Check any recent change or message before repeating it.",
    actionLabel: "Reload",
    retrySafe: false,
    dataUncertain: method !== "GET",
    deliveryUncertain: isSendPath(path)
  });
}

export function diagnosticMessage(error: unknown, fallback = "Unknown error"): string {
  const value =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : String(error ?? "");
  const singleLine = value.replace(/\s+/g, " ").trim();
  return (singleLine || fallback).slice(0, 500);
}

export function logConsumerFailure(
  consumerFailure: ConsumerFailure,
  error: unknown,
  context: ConsumerFailureContext = {}
): void {
  console.error("[consumer-failure]", {
    code: consumerFailure.code,
    path: context.path ?? null,
    method: context.method ?? null,
    status: context.status ?? null,
    phase: context.phase ?? null,
    retrySafe: consumerFailure.retrySafe,
    dataUncertain: consumerFailure.dataUncertain,
    deliveryUncertain: consumerFailure.deliveryUncertain,
    diagnostic: diagnosticMessage(error)
  });
}
