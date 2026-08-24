export type SendFailureKind =
  | "AUTH_REQUIRED"
  | "SELECTOR_FAIL"
  | "PROFILE_LOCKED"
  | "TRANSIENT"
  | "DELIVERY_UNCERTAIN"
  | "UNKNOWN";

export interface ConsumerSendFailure {
  errorKind: SendFailureKind;
  message: string;
  retrySafe: boolean;
  deliveryUncertain: boolean;
}

export function classifySendFailureKind(input: {
  message: string;
  adapterKind?: string;
}): SendFailureKind {
  if (
    /could not confirm.*deliver|no new outbound bubble|delivery (?:could not be confirmed|.*unconfirm|uncertain)|delivery status.*unknown|send interrupted|interrupted.*send|submitted message not observed|thread changed during send/i.test(
      input.message
    )
  ) {
    return "DELIVERY_UNCERTAIN";
  }
  if (input.adapterKind === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (input.adapterKind === "SELECTOR_MISMATCH") return "SELECTOR_FAIL";
  // A dropped or expired platform session surfaces as a raw "not connected" /
  // "call ensureConnected() first" / "disconnected before ready" / auth_failure
  // error. Retrying a dead session just fails again — the operator needs to
  // reconnect the account, so route these to AUTH_REQUIRED (needs reconnect).
  // This MUST sit above the TRANSIENT check: "ensureConnected" contains the
  // substring "eConn", which used to match the bare ECONN network-errno token
  // below and mislabel a fully disconnected adapter as a transient blip
  // (surfacing "connection stopped, retry" with no reconnect action).
  if (
    /not connected|ensureConnected|needs reconnect|disconnected before ready|session (closed|expired|ended)|logged out|auth[_ ]?fail/i.test(
      input.message
    )
  ) {
    return "AUTH_REQUIRED";
  }
  if (/profile.*lock|already in use|singleton/i.test(input.message)) return "PROFILE_LOCKED";
  // \bECONN (not a bare ECONN alternation) so real errno tokens like
  // ECONNRESET / ECONNREFUSED still match without catching the "eConn" inside
  // "ensureConnected".
  if (/timeout|temporarily|\bECONN|navigation/i.test(input.message)) return "TRANSIENT";
  return "UNKNOWN";
}

export function consumerSendFailure(errorKind: SendFailureKind): ConsumerSendFailure {
  switch (errorKind) {
    case "AUTH_REQUIRED":
      return {
        errorKind,
        message: "This account needs reconnecting. The message was not sent.",
        retrySafe: true,
        deliveryUncertain: false
      };
    case "SELECTOR_FAIL":
      return {
        errorKind,
        message: "The conversation changed on the connected service. The message was not sent.",
        retrySafe: true,
        deliveryUncertain: false
      };
    case "PROFILE_LOCKED":
      return {
        errorKind,
        message: "The browser session is busy. The message was not sent.",
        retrySafe: true,
        deliveryUncertain: false
      };
    case "TRANSIENT":
      return {
        errorKind,
        message: "The connection stopped before sending finished. The message was not sent.",
        retrySafe: true,
        deliveryUncertain: false
      };
    case "DELIVERY_UNCERTAIN":
      return {
        errorKind,
        message: "Delivery could not be confirmed. Check the conversation before sending again.",
        retrySafe: false,
        deliveryUncertain: true
      };
    default:
      return {
        errorKind: "UNKNOWN",
        message: "The message was not sent. Check the account before trying again.",
        retrySafe: true,
        deliveryUncertain: false
      };
  }
}

export function parsePersistedSendFailure(errorJson?: string | null): ConsumerSendFailure {
  if (!errorJson) return consumerSendFailure("UNKNOWN");
  try {
    const parsed = JSON.parse(errorJson) as { errorKind?: unknown; message?: unknown };
    const persistedKind = typeof parsed.errorKind === "string" ? parsed.errorKind : "UNKNOWN";
    const kind =
      persistedKind === "INTERRUPTED"
        ? "DELIVERY_UNCERTAIN"
        : classifySendFailureKind({
            message: typeof parsed.message === "string" ? parsed.message : "",
            adapterKind:
              persistedKind === "AUTH_REQUIRED" || persistedKind === "SELECTOR_MISMATCH"
                ? persistedKind
                : undefined
          });
    const knownKind = new Set<SendFailureKind>([
      "AUTH_REQUIRED",
      "SELECTOR_FAIL",
      "PROFILE_LOCKED",
      "TRANSIENT",
      "DELIVERY_UNCERTAIN"
    ]).has(persistedKind as SendFailureKind)
      ? (persistedKind as SendFailureKind)
      : kind;
    return consumerSendFailure(knownKind);
  } catch {
    return consumerSendFailure("UNKNOWN");
  }
}

export function persistedSendRetryEligibility(
  status: string,
  errorJson?: string | null
): { allowed: true } | { allowed: false; reason: "not_failed" | "delivery_uncertain" } {
  if (status !== "FAILED") {
    return { allowed: false, reason: "not_failed" };
  }
  const failure = parsePersistedSendFailure(errorJson);
  return failure.retrySafe && !failure.deliveryUncertain
    ? { allowed: true }
    : { allowed: false, reason: "delivery_uncertain" };
}
