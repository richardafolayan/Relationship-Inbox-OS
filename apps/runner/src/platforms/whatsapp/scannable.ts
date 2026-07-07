// Whether a scheduled or ALL-platform scan should include WhatsApp this pass.
//
// WhatsApp differs from LinkedIn / iMessage: an unlinked scan would launch a
// headless whatsapp-web.js Puppeteer instance and park it forever on a QR code
// nobody can see. So the runner only scans WhatsApp when BOTH:
//   - WHATSAPP_ENABLED=true (the master opt-in switch for a pilot), and
//   - the connect-state machine reports "connected" (a device is linked).
//
// A skip is not a failure — the scan loop just passes over WhatsApp this tick,
// writing no platform-row status or lastError. Explicit single-platform scan
// requests bypass this (the /control/scan route already 409s an unlinked
// WhatsApp scan with a clear reason).

export type WhatsAppConnectState =
  | "qr_ready"
  | "connecting"
  | "connected"
  | "disconnected";

export function isWhatsAppScannable(input: {
  enabled: boolean;
  state: WhatsAppConnectState;
}): boolean {
  return input.enabled && input.state === "connected";
}
