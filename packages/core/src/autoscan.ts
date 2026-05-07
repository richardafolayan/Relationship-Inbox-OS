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
  // Order:
  //   1. Legacy LINKEDIN_DEV_DISABLE_AUTOSCAN — kept for back-compat,
  //      forces disabled when truthy.
  //   2. Explicit NEXT_PUBLIC_DISABLE_AUTOSCAN — "0" enables, anything
  //      truthy disables.
  //   3. Default: ENABLED. The previous "default-disabled-in-dev" gate
  //      created friction (operators set =0 then have to restart Next.js
  //      for the bundled value to update). Auto-scan is harmless when
  //      OFF in localStorage; let the topbar toggle govern it directly.
  void input.nodeEnv;
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
  return false;
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
