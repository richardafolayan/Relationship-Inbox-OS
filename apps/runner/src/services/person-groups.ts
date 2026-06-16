export function normalizePersonGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of groups) {
    if (typeof raw !== "string") continue;
    const group = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!group || seen.has(group.toLowerCase())) continue;
    seen.add(group.toLowerCase());
    out.push(group);
    if (out.length >= 12) break;
  }
  return out;
}
