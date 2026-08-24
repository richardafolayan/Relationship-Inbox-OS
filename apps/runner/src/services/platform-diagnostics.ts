import type { PlatformName } from "@inbox-os/core";

const REDACTED = "[redacted]";

export function platformDiagnosticArtifactsAllowed(
  platform: PlatformName | string | undefined
): boolean {
  return platform !== "INSTAGRAM";
}

export function sanitizePlatformDiagnosticValue(
  platform: PlatformName | string | undefined,
  value: unknown
): unknown {
  if (platformDiagnosticArtifactsAllowed(platform)) {
    return value;
  }

  const seen = new WeakSet<object>();
  const sanitize = (candidate: unknown): unknown => {
    if (candidate === null || candidate === undefined) {
      return candidate;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "string") {
      return REDACTED;
    }
    if (candidate instanceof Error) {
      return { name: "Error" };
    }
    if (Array.isArray(candidate)) {
      return candidate.map(sanitize);
    }
    if (typeof candidate === "object") {
      if (seen.has(candidate)) {
        return REDACTED;
      }
      seen.add(candidate);
      const sanitized: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
        sanitized[key] = sanitize(entry);
      }
      return sanitized;
    }
    return REDACTED;
  };

  return sanitize(value);
}

interface PlatformAuditInput {
  platform?: PlatformName | string;
  details?: Record<string, unknown>;
  screenshotFile?: string;
  domDumpFile?: string;
}

export function sanitizePlatformAuditInput<T extends PlatformAuditInput>(input: T): T {
  if (platformDiagnosticArtifactsAllowed(input.platform)) {
    return input;
  }

  return {
    ...input,
    details: input.details
      ? (sanitizePlatformDiagnosticValue(input.platform, input.details) as Record<string, unknown>)
      : undefined,
    screenshotFile: undefined,
    domDumpFile: undefined
  };
}
