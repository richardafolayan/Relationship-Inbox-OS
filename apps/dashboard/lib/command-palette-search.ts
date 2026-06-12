// Pure search matching for the ⌘K command palette, extracted so the
// behaviour is testable without React/jsdom.
//
// #132: the palette must match against the FULL searchable text (person
// name + the whole latest-message preview), even though the visible label
// truncates the preview to ~60 chars. Otherwise a number deeper in the
// preview — "20-min", a date, an amount, an order code — is shown in the
// inbox but can't be found here. Matching is a case-insensitive substring
// so digits are searched exactly like letters (nothing strips them).

export interface PaletteSearchable {
  /** The visible row text (may be truncated for display). */
  label: string;
  /**
   * Full searchable text. When omitted, `label` is used — page/action
   * entries have no preview, so their label is already the whole text.
   */
  search?: string;
}

export function paletteItemMatches(item: PaletteSearchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (item.search ?? item.label).toLowerCase().includes(q);
}

// Clamp a selection index back into range for a (possibly resized) list.
// Used by the palette when its `items` change for a reason *other* than the
// user typing — e.g. the inbox fetch landing after open, or a background
// refresh. The old `setActiveIndex(0)` on `[items]` snapped the selection to
// the top mid-keyboard-navigation; clamping preserves the user's position and
// only pulls it in when it would otherwise point past the end. Never negative.
export function clampActiveIndex(current: number, length: number): number {
  if (length <= 0) return 0;
  if (current < 0) return 0;
  return Math.min(current, length - 1);
}
