export function summarizeControlBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { bodyType: typeof body };
  }

  const record = body as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    bodyKeys: Object.keys(record).slice(0, 12)
  };

  if (typeof record.platform === "string") {
    summary.platform = record.platform;
  }
  if (typeof record.mode === "string") {
    summary.mode = record.mode;
  }
  if (typeof record.key === "string") {
    summary.hasKey = true;
  }
  if (typeof record.hours === "number") {
    summary.hours = record.hours;
  }
  if (typeof record.selector === "string") {
    summary.selectorLength = record.selector.length;
  }
  if (typeof record.text === "string") {
    summary.textLength = record.text.length;
  }
  if (typeof record.clientSendId === "string") {
    summary.hasClientSendId = true;
  }

  return summary;
}
