export const INBOX_INITIAL_VISIBLE_ROWS = 80;
export const INBOX_PAGE_ROWS = 80;

export function nextInboxVisibleCount(current: number, total: number): number {
  return Math.min(Math.max(0, total), Math.max(0, current) + INBOX_PAGE_ROWS);
}

export function windowInboxSections<T, S extends { items: T[] }>(
  sections: readonly S[],
  visibleCount: number
): S[] {
  let remaining = Math.max(0, visibleCount);
  const result: S[] = [];

  for (const section of sections) {
    if (remaining === 0) break;
    const items = section.items.slice(0, remaining);
    if (items.length === 0) continue;
    result.push({ ...section, items });
    remaining -= items.length;
  }

  return result;
}
