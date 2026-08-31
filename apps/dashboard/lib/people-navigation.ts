export function buildPersonInboxHref(personId: string, personName: string): string {
  const name = personName.trim();
  return `/inbox?personId=${encodeURIComponent(personId)}${
    name ? `&q=${encodeURIComponent(name)}` : ""
  }`;
}
