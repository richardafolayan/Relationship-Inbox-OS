function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function isSponsoredPillText(text: string): boolean {
  return clean(text).toLowerCase() === "sponsored";
}

export function isPreviewFromMe(preview: string): boolean {
  return clean(preview).toLowerCase().startsWith("you:");
}

export function needsReplyFromPreview(preview: string): boolean {
  const normalized = clean(preview);
  if (!normalized || normalized === "-") {
    return false;
  }
  if (isPreviewFromMe(normalized)) {
    return false;
  }

  // LinkedIn list snippets usually include "<Name>:" when last message is inbound.
  return /^[^:]{1,120}:\s*\S/.test(normalized);
}
