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
