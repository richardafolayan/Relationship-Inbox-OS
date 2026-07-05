// Pilot R-0089 (#756): the sidebar/dock "Today" marker is a count again —
// how many threads still need a reply in today's queue — capped at 99+.
// The count reuses the shell's attentionCount (rows passing isInTodayQueue,
// the same number Today's "N need you tonight" renders), so the two never
// disagree.
export const ATTENTION_BADGE_CAP = 99;

export function formatAttentionBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  const whole = Math.floor(count);
  if (whole <= 0) return "";
  return whole > ATTENTION_BADGE_CAP ? `${ATTENTION_BADGE_CAP}+` : String(whole);
}
