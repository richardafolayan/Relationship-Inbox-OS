function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) {
    return fallback;
  }
  return isTruthy(raw);
}

export function envInt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function getLinkedInDevScanCaps(): {
  maxThreads?: number;
  maxOpens?: number;
  disableDeepScroll: boolean;
} {
  if (!isDev()) {
    return {
      disableDeepScroll: false
    };
  }
  return {
    maxThreads: envInt("LINKEDIN_DEV_SCAN_MAX_THREADS"),
    maxOpens: envInt("LINKEDIN_DEV_SCAN_MAX_OPENS"),
    disableDeepScroll: envBool("LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL", false)
  };
}

export function getDevLoggingFlags(): { stageHeadlines: boolean } {
  if (!isDev()) {
    return {
      stageHeadlines: false
    };
  }
  return {
    stageHeadlines: envBool("LINKEDIN_DEV_LOG_STAGE_HEADLINES", true)
  };
}

export function isAutoScanDisabledInDev(): boolean {
  if (!isDev()) {
    return false;
  }
  return envBool("LINKEDIN_DEV_DISABLE_AUTOSCAN", true);
}
