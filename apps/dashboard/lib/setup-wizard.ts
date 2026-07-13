// First-run setup wizard (#845, pilot R-0109).
//
// New installs land on Today with an empty inbox, no AI key, and nothing
// connected; the only setup path was hand-editing .env. The wizard is a
// full-screen overlay shown before Today that walks a first-time user
// through the two things the app needs: a free Gemini API key and at least
// one connected message platform. Everything is skippable; nobody is ever
// trapped in it.
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
  /** Fresh install with nothing configured: show the wizard. */
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
 * Decide whether the wizard shows on app open. Setup counts as incomplete
 * only when BOTH the AI key and every platform are missing. Unknown state
 * (runner offline, request failed) never shows the wizard: a flaky boot
 * must not greet an already-set-up operator with first-run setup.
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
