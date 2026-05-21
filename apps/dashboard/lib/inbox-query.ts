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
