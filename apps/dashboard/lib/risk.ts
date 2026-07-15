// Map runner risk values to display vocabulary. The runner emits
// RED/AMBER/GREEN; the UI speaks overdue/waiting/fresh. Centralizing the
// translation keeps every page in one voice.

export type RunnerRisk = "RED" | "AMBER" | "GREEN";
export type DisplayRisk = "overdue" | "waiting" | "fresh";

export function toDisplayRisk(level: RunnerRisk): DisplayRisk {
  if (level === "RED") return "overdue";
  if (level === "AMBER") return "waiting";
  return "fresh";
}

export const PLATFORM_LABEL: Record<
  "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP",
  string
> = {
  LINKEDIN: "linkedin",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  IMESSAGE: "imessage",
  WHATSAPP: "whatsapp"
};

// Compatibility fallback for an older runner that does not return platform
// cards. Current runners return the exact env-enabled set.
export const IMPLEMENTED_PLATFORMS: ReadonlyArray<
  "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP"
> = ["LINKEDIN", "IMESSAGE"];

// The platform set the operator sees in connected counts, the reconnect
// modal, and filter chips. /data/platforms is already filtered by the runner's
// environment switches, so the dashboard mirrors it exactly.
export function visibleImplementedPlatforms(
  platforms: ReadonlyArray<{
    platform: string;
    connectedAt: string | null;
    enabled?: boolean;
    supported?: boolean;
  }> | null | undefined
): ReadonlyArray<"LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP"> {
  if (!platforms) return IMPLEMENTED_PLATFORMS;
  return platforms
    .filter((platform) => platform.supported !== false)
    .filter(
      (platform) =>
        platform.platform !== "WHATSAPP" || platform.enabled || hasEverConnected(platform)
    )
    .map((platform) => platform.platform)
    .filter(
      (platform): platform is "LINKEDIN" | "IMESSAGE" | "WHATSAPP" =>
        platform === "LINKEDIN" || platform === "IMESSAGE" || platform === "WHATSAPP"
    );
}

// A platform the operator has never connected is "not set up", not "broken".
// A failed background scan against an unconnected platform (e.g. LinkedIn is
// enabled by default, so an auth-required scan can mark it DEGRADED) must NOT
// surface as a scary "something looks off" error to someone who never opted in.
// `connectedAt` is only ever set by a successful connect, so a null value is a
// reliable "never set up / doesn't use this" signal. (issue #708)
export function hasEverConnected(platform: { connectedAt: string | null }): boolean {
  return Boolean(platform.connectedAt);
}

// Only surface a degraded/error banner for a platform the operator actually
// uses — i.e. one they have connected at least once. Keeps the Today, Inbox,
// and Thread surfaces consistent so a non-user never sees a platform error.
export function isDegradedAndInUse(platform: {
  status: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
  connectedAt: string | null;
}): boolean {
  return platform.status === "DEGRADED" && hasEverConnected(platform);
}

export function initials(name: string): string {
  // Only take the first character of name parts that START with a letter.
  // Without this filter, "Cynthia (ACS)" would render as "C(" because the
  // second token's first char is an open paren. Unicode letter category
  // covers accented names ("José") without needing per-locale handling.
  // If no parts start with a letter, fall back to the first character of
  // the first non-empty token so the avatar isn't blank for edge-case
  // names like "(ACS)" alone.
  const parts = name.split(/\s+/).filter(Boolean);
  const letterParts = parts.filter((word) => /^\p{L}/u.test(word));
  const chosen = letterParts.length > 0 ? letterParts.slice(0, 2) : parts.slice(0, 1);
  return chosen
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase();
}

// Six muted avatar tones, picked deterministically by FNV-1a hash of the
// person's name so a list of 30 rows scans as visually varied without
// shouting. Same person, same colour, across pages and reloads.
const AVATAR_TONES = [
  "linear-gradient(135deg, oklch(72% 0.10 35), oklch(60% 0.13 22))",
  "linear-gradient(135deg, oklch(70% 0.09 145), oklch(56% 0.11 155))",
  "linear-gradient(135deg, oklch(68% 0.10 245), oklch(54% 0.13 252))",
  "linear-gradient(135deg, oklch(74% 0.09 75), oklch(60% 0.12 65))",
  "linear-gradient(135deg, oklch(70% 0.11 305), oklch(56% 0.14 295))",
  "linear-gradient(135deg, oklch(66% 0.07 200), oklch(52% 0.09 210))"
];

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function avatarTone(name: string): string {
  return AVATAR_TONES[fnv1a(name) % AVATAR_TONES.length] ?? AVATAR_TONES[0]!;
}
