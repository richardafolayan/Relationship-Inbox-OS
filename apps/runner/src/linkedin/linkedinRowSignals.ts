function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isSponsoredPillText(text: string): boolean {
  return clean(text).toLowerCase() === "sponsored";
}

export function isPreviewFromMe(preview: string): boolean {
  return /^you\s*:/i.test(clean(preview));
}

export function needsReplyFromPreview(preview: string): boolean {
  const normalized = clean(preview);
  if (!normalized) {
    return false;
  }
  return !isPreviewFromMe(normalized);
}
