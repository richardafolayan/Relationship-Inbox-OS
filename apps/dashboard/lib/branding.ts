// Client + server safe app display name for the dashboard.
//
// The browser bundle only sees NEXT_PUBLIC_* env vars, and Next inlines
// `process.env.NEXT_PUBLIC_APP_NAME` at build time. next.config.mjs feeds that
// from RIOS_APP_NAME so a single .env variable renames the app everywhere.
// Falls back to "Tovi".
//
// Referenced as a literal `process.env.NEXT_PUBLIC_APP_NAME` (not via a helper
// arg) so Next's DefinePlugin can inline it into the client bundle.
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Tovi";

// The pre-rebrand product name, for the few places that must name the old
// install (e.g. "remove the old Relationship Inbox OS app"). Never rebranded.
export const LEGACY_APP_NAME = "Relationship Inbox OS";
