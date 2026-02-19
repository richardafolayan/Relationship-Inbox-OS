export interface AutoScanEnvInput {
  nodeEnv?: string;
  disableAutoScan?: string;
  legacyDisableAutoScan?: string;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveAutoScanDisabled(input: AutoScanEnvInput): boolean {
  const isProd = input.nodeEnv === "production";
  if (isTruthy(input.legacyDisableAutoScan)) {
    return true;
  }

  if (input.disableAutoScan !== undefined) {
    if (input.disableAutoScan.trim() === "0") {
      return false;
    }
    if (isTruthy(input.disableAutoScan)) {
      return true;
    }
  }

  if (isProd) {
    return false;
  }
  return true;
}

export function resolveAutoScanInitialEnabled(input: {
  envDisabled: boolean;
  storedValue: string | null;
}): boolean {
  if (input.envDisabled) {
    return false;
  }
  return input.storedValue === "true";
}
