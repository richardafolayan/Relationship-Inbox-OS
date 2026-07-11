export function nextSendReconcileDelayMs(elapsedMs: number, visible = true): number {
  if (!visible) return 5_000;
  if (elapsedMs < 5_000) return 250;
  if (elapsedMs < 15_000) return 750;
  if (elapsedMs < 60_000) return 2_000;
  return 5_000;
}
