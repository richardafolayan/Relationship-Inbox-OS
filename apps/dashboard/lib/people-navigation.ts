export function buildPersonInboxHref(name: string): string {
  return `/inbox?q=${encodeURIComponent(name.trim())}`;
}
