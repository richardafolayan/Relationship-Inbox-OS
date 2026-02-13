import { AdapterFailure, inferAdapterFailureKindFromMessage } from "../platforms/utils.js";
import type { AdapterFailureKind } from "../platforms/utils.js";

export type ConnectFailureType =
  | "AUTH_REQUIRED"
  | "CONNECT_TIMEOUT"
  | "PROFILE_CONFIG"
  | "PROFILE_LOCKED"
  | "SELECTOR_MISMATCH"
  | "NAVIGATION_ERROR"
  | "UNKNOWN";

export function resolveAdapterFailureKind(error: unknown): AdapterFailureKind | undefined {
  if (error instanceof AdapterFailure && error.kind) {
    return error.kind;
  }

  const message = error instanceof Error ? error.message : String(error);
  return inferAdapterFailureKindFromMessage(message);
}

export function classifyConnectFailureType(input: {
  message: string;
  failureKind?: AdapterFailureKind;
}): ConnectFailureType {
  if (input.failureKind === "AUTH_REQUIRED") {
    return "AUTH_REQUIRED";
  }
  if (input.failureKind === "SELECTOR_MISMATCH") {
    return "SELECTOR_MISMATCH";
  }
  if (input.failureKind === "NAVIGATION_FAILED") {
    return "NAVIGATION_ERROR";
  }

  const normalized = input.message.toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("connect_timeout")) {
    return "CONNECT_TIMEOUT";
  }
  if (normalized.includes("non-default data directory") || normalized.includes("remote debugging requires")) {
    return "PROFILE_CONFIG";
  }
  if (normalized.includes("locked by another chrome process") || normalized.includes("singleton") || normalized.includes("already in use")) {
    return "PROFILE_LOCKED";
  }
  if (normalized.includes("inbox selector missing") || normalized.includes("selector")) {
    return "SELECTOR_MISMATCH";
  }
  if (normalized.includes("navigation") || normalized.includes("net::")) {
    return "NAVIGATION_ERROR";
  }
  return "UNKNOWN";
}

export function resolveConnectFailureResponse(input: {
  message: string;
  error: unknown;
}): {
  failureKind?: AdapterFailureKind;
  failureType: ConnectFailureType;
  httpStatus: 401 | 500 | 504;
  platformStatus: "NOT_CONNECTED" | "ERROR";
} {
  const failureKind = resolveAdapterFailureKind(input.error);
  const failureType = classifyConnectFailureType({
    message: input.message,
    failureKind
  });

  if (failureType === "AUTH_REQUIRED") {
    return {
      failureKind,
      failureType,
      httpStatus: 401,
      platformStatus: "NOT_CONNECTED"
    };
  }

  if (failureType === "CONNECT_TIMEOUT") {
    return {
      failureKind,
      failureType,
      httpStatus: 504,
      platformStatus: "ERROR"
    };
  }

  return {
    failureKind,
    failureType,
    httpStatus: 500,
    platformStatus: "ERROR"
  };
}

export function extractFailureUrl(error: unknown, message: string): string | undefined {
  if (error instanceof AdapterFailure) {
    const url = error.details?.url;
    if (typeof url === "string" && url.length > 0) {
      return url;
    }
  }

  const match = message.match(/\burl:\s*(https?:\/\/\S+)/i);
  if (!match?.[1]) {
    return undefined;
  }

  return match[1].replace(/[)\],.;]+$/, "");
}

export function shouldStopScanForFailureKind(failureKind?: AdapterFailureKind): boolean {
  return failureKind === "AUTH_REQUIRED";
}
