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
    /could not confirm.*deliver|no new outbound bubble|delivery.*unconfirm|delivery status.*unknown|send interrupted|interrupted.*send/i.test(
      input.message
    )
  ) {
    return "DELIVERY_UNCERTAIN";
  }
  if (input.adapterKind === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (input.adapterKind === "SELECTOR_MISMATCH") return "SELECTOR_FAIL";
  if (/profile.*lock|already in use|singleton/i.test(input.message)) return "PROFILE_LOCKED";
  if (/timeout|temporarily|ECONN|navigation/i.test(input.message)) return "TRANSIENT";
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
