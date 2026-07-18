// Phone-safe media URL helpers for thread attachments.
//
// The dashboard is reachable from a phone over the LAN/Tailscale phone-access
// proxy. Absolute URLs that embed localhost / 127.0.0.1 / other Mac-only hosts
// resolve on the Mac but fail on the phone (broken-image placeholder). Relative
// paths under `/runner/data/...` stay same-origin and work through the proxy.
//
// These helpers are pure so unit tests cover rewriting without a browser.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

export type AttachmentMediaPlatform =
  | "imessage"
  | "whatsapp"
  | "google_messages"
  | "linkedin_voice";

/**
 * True when a hostname can only be reached from the Mac itself (or a
 * same-machine loopback). Phone clients cannot load these origins.
 */
export function isLocalOnlyHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (LOCAL_HOSTS.has(host)) return true;
  // Strip IPv6 brackets if present, then re-check.
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (LOCAL_HOSTS.has(unbracketed)) return true;
  if (unbracketed === "localhost" || unbracketed.endsWith(".localhost")) return true;
  // Bonjour / mDNS hostnames are Mac-LAN-only and not phone-safe either.
  if (unbracketed.endsWith(".local")) return true;
  return false;
}

/**
 * Ensure attachment paths go through the dashboard's `/runner` rewrite rather
 * than the runner's bare `/data/...` routes. Phone clients hit the dashboard
 * origin; only `/runner/*` is proxied to the runner process.
 */
export function normalizeRunnerMediaPath(pathWithQuery: string): string {
  if (!pathWithQuery) return pathWithQuery;
  const hashIndex = pathWithQuery.indexOf("#");
  const hash = hashIndex >= 0 ? pathWithQuery.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? pathWithQuery.slice(0, hashIndex) : pathWithQuery;
  const queryIndex = withoutHash.indexOf("?");
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex) : "";
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  if (pathname === "/data" || pathname.startsWith("/data/")) {
    return `/runner${pathname}${query}${hash}`;
  }
  return `${pathname}${query}${hash}`;
}

/**
 * Rewrite a media URL so a phone on the current request origin can load it.
 *
 * - Relative `/...` paths are already same-origin; normalize `/data` → `/runner/data`.
 * - Absolute URLs on localhost / 127.0.0.1 / *.local collapse to a same-origin path.
 * - `file://` paths cannot be served to a browser; return empty string.
 * - Non-local absolute URLs (LinkedIn avatars, remote CDNs) pass through unchanged.
 *
 * `currentOrigin` is accepted for future absolute rebuilds; today the rewrite
 * always prefers a relative path so the phone's live origin is used.
 */
export function rewriteLocalMediaUrl(
  url: string,
  currentOrigin?: string | null
): string {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return "";

  if (/^file:/i.test(raw)) {
    return "";
  }

  // Protocol-relative URLs still need host inspection.
  if (raw.startsWith("//")) {
    try {
      const parsed = new URL(`http:${raw}`);
      if (isLocalOnlyHostname(parsed.hostname)) {
        return normalizeRunnerMediaPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
      }
      return raw;
    } catch {
      return raw;
    }
  }

  // Already relative to the current origin.
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return normalizeRunnerMediaPath(raw);
  }

  let parsed: URL;
  try {
    // Base is only used when `raw` is absolute-or-relative against an origin.
    // Prefer the live page origin when provided so relative inputs resolve
    // correctly; fall back to a dummy base for absolute inputs.
    parsed = new URL(raw, currentOrigin || "http://media.local");
  } catch {
    return raw;
  }

  if (!isLocalOnlyHostname(parsed.hostname)) {
    return raw;
  }

  return normalizeRunnerMediaPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

/**
 * Build the stable dashboard path for a platform attachment. Always relative
 * so the phone-accessible origin serves it through the `/runner` rewrite.
 */
export function attachmentMediaPath(input: {
  guid: string;
  platform?: AttachmentMediaPlatform;
  isLinkedInVoice?: boolean;
}): string {
  const guid = encodeURIComponent(input.guid);
  if (input.isLinkedInVoice || input.platform === "linkedin_voice") {
    return `/runner/data/linkedin-voice-message/${guid}`;
  }
  if (input.platform === "whatsapp") {
    return `/runner/data/whatsapp-attachment/${guid}`;
  }
  if (input.platform === "google_messages") {
    return `/runner/data/google-messages-attachment/${guid}`;
  }
  return `/runner/data/imessage-attachment/${guid}`;
}

/**
 * Append a cache-busting retry query so the browser re-requests after a
 * transient failure (iCloud still downloading, short network blip).
 */
export function withMediaRetryParam(url: string, attempt: number): string {
  if (!url || attempt <= 0) return url;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}_retry=${attempt}${hash}`;
}

export function mediaKindLabel(
  kind: string | null | undefined
): string {
  switch (kind) {
    case "voice_note":
      return "Voice note";
    case "photo":
      return "Photo";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "sticker":
      return "Sticker";
    case "gif":
      return "GIF";
    case "poll":
      return "Poll";
    default:
      return "Attachment";
  }
}
