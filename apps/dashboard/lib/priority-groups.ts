import { apiPost } from "./api";
import type { InboxRow } from "./types";

export function normalizePriorityGroups(groups: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of groups) {
    const group = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!group || seen.has(group.toLowerCase())) continue;
    seen.add(group.toLowerCase());
    out.push(group);
    if (out.length >= 12) break;
  }
  return out;
}

export function rowMatchesPriorityGroup(row: Pick<InboxRow, "personGroups">, group: string): boolean {
  if (group === "all") return true;
  return (row.personGroups ?? []).some((candidate) => candidate.toLowerCase() === group.toLowerCase());
}

export async function setPriorityGroups(personId: string, groups: readonly string[]): Promise<string[]> {
  const result = await apiPost<{ groups: string[] }>(
    `/runner/control/person/${personId}/groups`,
    { groups: normalizePriorityGroups(groups) }
  );
  return result.groups;
}
