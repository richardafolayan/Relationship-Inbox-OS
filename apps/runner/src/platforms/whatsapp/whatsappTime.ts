// whatsapp-web.js exposes timestamps as epoch SECONDS (not milliseconds),
// matching the WhatsApp wire protocol. The rest of the app stores ISO
// strings on Message.timestamp / Thread.lastMessageAt etc., so the adapter
// converts at the boundary.

export function epochSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

export function isoToEpochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
