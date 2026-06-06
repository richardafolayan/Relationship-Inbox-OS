import type { PlatformName } from "@inbox-os/core";

// Security policy for person.profileUrl values that get navigated to in the
// runner's *authenticated* Chrome session (openProfileUrl, and the enrichment
// queue's auto-visit). A raw `z.string().url()` accepts file://, view-source:,
// data:, http://169.254.169.254 and arbitrary intranet hosts, so a persisted
// or legacy bad value becomes a stored SSRF / local-file read the moment the
// runner navigates to it. We pin navigable profile URLs to https/http on an
// allowlisted host (linkedin.com for LinkedIn persons) and re-check at both the
// write boundary and the navigation boundary so legacy rows are rejected too.

export class ProfileUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileUrlPolicyError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

// Host allowlist per platform. Only platforms whose adapter actually navigates
// to a profile URL need an entry; everything else is denied by default.
const ALLOWED_HOST_SUFFIXES: Partial<Record<PlatformName, readonly string[]>> = {
  LINKEDIN: ["linkedin.com"]
};

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Validate a profile URL against the navigation allowlist and return its
 * normalised string form. Throws {@link ProfileUrlPolicyError} for anything
 * that isn't https/http on an allowlisted host for the given platform
 * (file://, view-source:, data:, link-local / intranet hosts, look-alike
 * domains like `linkedin.com.evil.test`, etc.).
 */
export function parseAllowedProfileUrl(rawUrl: string, platform: PlatformName): string {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) {
    throw new ProfileUrlPolicyError("profile URL is empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProfileUrlPolicyError(`profile URL is not a valid absolute URL: ${trimmed}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ProfileUrlPolicyError(
      `profile URL scheme "${parsed.protocol}" is not allowed (expected https/http)`
    );
  }

  const allowedSuffixes = ALLOWED_HOST_SUFFIXES[platform];
  if (!allowedSuffixes) {
    throw new ProfileUrlPolicyError(`profile URLs are not permitted for platform ${platform}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const hostAllowed = allowedSuffixes.some((suffix) => hostMatchesSuffix(hostname, suffix));
  if (!hostAllowed) {
    throw new ProfileUrlPolicyError(
      `profile URL host "${parsed.hostname}" is not on the ${platform} allowlist`
    );
  }

  return parsed.toString();
}

/**
 * Non-throwing companion to {@link parseAllowedProfileUrl} — true when the URL
 * is navigable under the policy for the given platform.
 */
export function isAllowedProfileUrl(rawUrl: string, platform: PlatformName): boolean {
  try {
    parseAllowedProfileUrl(rawUrl, platform);
    return true;
  } catch {
    return false;
  }
}
