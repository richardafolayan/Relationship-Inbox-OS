export interface SendStatusResponse {
  clientSendId: string;
  threadId?: string;
  status: "NOT_FOUND" | "PENDING" | "SCHEDULED" | "SENT" | "FAILED" | "CANCELLED";
  errorMessage?: string;
  errorKind?: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "DELIVERY_UNCERTAIN" | "UNKNOWN";
  retrySafe?: boolean;
  deliveryUncertain?: boolean;
}

export type SendRecoveryOutcome =
  | { kind: "waiting" }
  | { kind: "sent" }
  | { kind: "not_sent"; message: string }
  | { kind: "failed"; message: string; errorKind?: SendStatusResponse["errorKind"] }
  | { kind: "uncertain"; message: string };

export function resolveSendRecovery(response: SendStatusResponse): SendRecoveryOutcome {
  if (response.status === "SENT") return { kind: "sent" };
  if (response.status === "PENDING" || response.status === "SCHEDULED") {
    return { kind: "waiting" };
  }
  if (response.status === "NOT_FOUND" || response.status === "CANCELLED") {
    return {
      kind: "not_sent",
      message: "This message did not reach the send queue. It is safe to review and send again."
    };
  }
  if (response.deliveryUncertain || response.errorKind === "DELIVERY_UNCERTAIN") {
    return {
      kind: "uncertain",
      message: "Delivery could not be confirmed. Check the conversation before sending again."
    };
  }
  return {
    kind: "failed",
    message: response.errorMessage ?? "The message was not sent. Check the account before trying again.",
    errorKind: response.errorKind
  };
}
