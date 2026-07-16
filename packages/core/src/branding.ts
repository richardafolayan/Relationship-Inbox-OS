// The single source of truth for the app's *display* name.
//
// The name shown to users (window title, UI, dialogs, prompts) is driven by
// the RIOS_APP_NAME environment variable so the whole product can be
// rebranded from one place in .env. It falls back to "Tovi".
//
// IMPORTANT: this is the display name only. The storage identity — bundle id
// ("relationship-inbox-os"), the Application Support folder ("Relationship
// Inbox OS") and the logs folder ("RelationshipInboxOS") — is deliberately
// NOT derived from this. Those are pinned to the pre-rebrand names so macOS
// TCC grants and every existing install's data keep working. See
// apps/desktop/launcher.cjs.
//
// On the dashboard client, process.env only exposes NEXT_PUBLIC_* vars, so the
// browser reads NEXT_PUBLIC_APP_NAME (wired from RIOS_APP_NAME in
// next.config.mjs). resolveAppName() accepts either.

export const DEFAULT_APP_NAME = "Tovi";

// The original, pre-rebrand product name. Used only where we must refer to the
// old install by its historical name (e.g. "remove the old Relationship Inbox
// OS app"). This never changes when the display name is rebranded.
export const LEGACY_APP_NAME = "Relationship Inbox OS";

const APP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;

export function resolveAppName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RIOS_APP_NAME ?? env.NEXT_PUBLIC_APP_NAME ?? "").trim();
  const value = raw || DEFAULT_APP_NAME;
  if (!APP_NAME_PATTERN.test(value)) {
    throw new Error(
      "RIOS_APP_NAME must be 1-80 letters, numbers, spaces, dots, underscores, parentheses or hyphens."
    );
  }
  return value;
}
