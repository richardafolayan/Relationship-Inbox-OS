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

export const PLATFORM_LABEL: Record<"LINKEDIN" | "INSTAGRAM" | "TIKTOK", string> = {
  LINKEDIN: "linkedin",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok"
};

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}
