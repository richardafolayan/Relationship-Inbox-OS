import { apiPost } from "./api";
import type { InboxRow } from "./types";

// Operator-pinned favourite contacts (pilot feedback R-0066 / #483).
//
// A favourited contact's threads float to the TOP of the list they already
// belong to — the Inbox section or the Today risk bucket — without reordering
// across risk levels and without changing the chronological order within the
// favourite / non-favourite split. Favourites are a tie lifted inside the
// existing order, never a new global sort: an overdue non-favourite still
// outranks a fresh favourite. The Inbox can additionally filter to favourites
// only, so the star doubles as a lightweight lens.

export function isFavouriteRow(row: Pick<InboxRow, "personFavourite">): boolean {
  return row.personFavourite === true;
}

/**
 * Stable favourites-first partition. Keeps the incoming order within the
 * favourite and non-favourite groups, so whatever sort the caller already
 * applied (oldest wait, most recent, name A-Z, Today's oldest-inbound) is
 * preserved inside each group. Apply this per Inbox section / per Today risk
 * bucket — never across the whole list, or favourites would jump risk levels.
 */
export function favouritesFirst<T extends { personFavourite?: boolean | null }>(
  rows: readonly T[]
): T[] {
  const favourites: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    if (row.personFavourite) favourites.push(row);
    else rest.push(row);
  }
  return [...favourites, ...rest];
}

/**
 * Toggle / set a contact's favourite state. Centralised so every surface
 * (inbox row, today hero, thread header, profile drawer) hits the same
 * endpoint with an explicit `favourite` flag — explicit rather than a bare
 * toggle so an optimistic star can't drift out of sync on a fast double click.
 */
export async function setFavourite(personId: string, favourite: boolean): Promise<void> {
  await apiPost(`/runner/control/person/${personId}/favourite`, { favourite });
}
