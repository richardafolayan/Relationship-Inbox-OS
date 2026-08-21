export const INITIAL_SIBLING_LIMIT = 80;
export const SIBLING_PAGE_SIZE = 80;

export function boundedSiblingRows<T extends { id: string }>(
  rows: readonly T[],
  visibleLimit: number,
  selected: T | null | undefined
): T[] {
  const limit = Math.max(1, Math.floor(visibleLimit));
  const visible = rows.slice(0, limit);
  if (!selected || visible.some((row) => row.id === selected.id)) return visible;
  if (visible.length < limit) return [...visible, selected];
  return [...visible.slice(0, limit - 1), selected];
}
