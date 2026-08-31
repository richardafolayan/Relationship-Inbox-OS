// Reads the inbox `?q=` deep-link param. The thread participant popover's
// "Find 1:1 thread" action links to /inbox?q=<handle>; the inbox redesign
// dropped the handling that applied it (regression of issue #211). Kept
// pure + standalone so it can be unit-tested without a browser.
export function readInboxQueryParam(search: string): string {
  try {
    return new URLSearchParams(search).get("q")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function readInboxPersonIdParam(search: string): string {
  try {
    return new URLSearchParams(search).get("personId")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function inboxRowMatchesLookup(
  row: {
    personId?: string;
    personName: string;
    preview?: string | null;
  },
  lookup: { query: string; personId: string }
): boolean {
  if (lookup.personId) return row.personId === lookup.personId;
  const query = lookup.query.trim().toLowerCase();
  if (!query) return true;
  return (
    row.personName.toLowerCase().includes(query) ||
    (row.preview ?? "").toLowerCase().includes(query)
  );
}
