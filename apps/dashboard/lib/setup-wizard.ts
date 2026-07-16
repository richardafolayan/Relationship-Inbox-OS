// First-run setup wizard (#845, pilot R-0109).
//
// New installs land on Today with an empty inbox, no AI key, and nothing
// connected; the only setup path was hand-editing .env. The wizard is a
// full-screen overlay shown before Today that walks a first-time user
// through identity, chosen message sources, Contacts, optional AI, optional
// local transcription, and updates. Nothing is required just to reach Today.
//
// This module holds the pure, node-testable pieces: the gating decision,
// the localStorage flag, and the window-event bridge Settings uses to
// reopen the wizard (same pattern as lib/pilot-tour.ts).

export const SETUP_WIZARD_COMPLETE_KEY = "relationship-inbox-os:setup-wizard-complete:v1";

/** Window event the Settings "Run setup assistant" button dispatches. */
export const SETUP_WIZARD_START_EVENT = "setup-wizard-start";

export interface SetupWizardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isSetupComplete(storage: SetupWizardStorage): boolean {
  return storage.getItem(SETUP_WIZARD_COMPLETE_KEY) === "1";
}

export function markSetupComplete(storage: SetupWizardStorage): void {
  storage.setItem(SETUP_WIZARD_COMPLETE_KEY, "1");
}

export type SetupGateDecision =
  /** Fresh install with no previous setup state: show the wizard. */
  | "show"
  /**
   * The install is already set up (an AI provider is configured or a
   * platform is connected): persist the complete flag so the wizard is
   * never evaluated again, and do not show it. Protects every existing
   * install upgrading into the build that introduces the wizard.
   */
  | "auto-complete"
  /** Already completed/dismissed, or state is unknown: stay out of the way. */
  | "hidden";

export interface SetupGateInput {
  /** localStorage complete flag already set. */
  storedComplete: boolean;
  /** Any AI provider has a key, or null when the runner couldn't be read. */
  aiConfigured: boolean | null;
  /** Any platform is connected, or null when the runner couldn't be read. */
  anyPlatformConnected: boolean | null;
}

/**
 * Legacy upgrade gate retained for older callers and its regression tests.
 * The current wizard also reads durable setup progress from the runner.
 * Unknown state never shows first-run UI over a temporarily offline app.
 */
export function resolveSetupGate(input: SetupGateInput): SetupGateDecision {
  if (input.storedComplete) return "hidden";
  if (input.aiConfigured === null || input.anyPlatformConnected === null) return "hidden";
  if (input.aiConfigured || input.anyPlatformConnected) return "auto-complete";
  return "show";
}

// ── Window-event bridge ────────────────────────────────────────────────

export function startSetupWizard(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SETUP_WIZARD_START_EVENT));
}

export function onSetupWizardStart(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(SETUP_WIZARD_START_EVENT, handler);
  return () => window.removeEventListener(SETUP_WIZARD_START_EVENT, handler);
}
