// Pure decision logic for POST /control/person/:personId/rename.
//
// Extracted from the route handler so the idempotency rule below is unit
// testable (the handler boots the whole runner + Prisma, which is not). The
// handler stays a thin shell: look up the person, call this, apply `write`
// (if any), then send `status` + `body`.

export type PersonNameAction = "confirm" | "rename" | "dismiss";

export interface PersonNameActionInput {
  action: PersonNameAction;
  /** Required for "rename"; ignored otherwise. */
  name?: string;
}

/** The subset of a Person this decision reads. */
export interface PersonNameSubject {
  inferredName: string | null;
  displayName: string | null;
}

export interface PersonNameActionDecision {
  /** HTTP status the handler should return. */
  status: number;
  /**
   * Prisma `data` for `person.update`, or `null` when no write is needed
   * (a validation error, or an idempotent no-op).
   */
  write: { displayName?: string; displayNameSource?: "manual"; inferredName?: null } | null;
  /** JSON body to send back. */
  body: Record<string, unknown>;
}

export function decidePersonNameAction(
  person: PersonNameSubject,
  input: PersonNameActionInput
): PersonNameActionDecision {
  if (input.action === "confirm") {
    // Idempotent confirm. A duplicate or stale confirm — a fast double-click, a
    // re-click when there was no visible "saving" state, or the row already
    // resolved in another tab — finds `inferredName` already cleared. The first
    // confirm has already promoted the name, so this is a successful no-op, not
    // a 409. Returning an error here surfaced a spurious failure (the Next.js
    // dev error overlay) for an action that had actually succeeded.
    if (!person.inferredName) {
      return { status: 200, write: null, body: { status: "ok", displayName: person.displayName } };
    }
    return {
      status: 200,
      // "manual" locks the name: auto-refresh (e.g. the iMessage group-name
      // sync in scan-queue) must never overwrite an operator's choice.
      write: { displayName: person.inferredName, displayNameSource: "manual", inferredName: null },
      body: { status: "ok", displayName: person.inferredName }
    };
  }
  if (input.action === "rename") {
    if (!input.name) {
      return { status: 400, write: null, body: { error: "name is required for rename" } };
    }
    return {
      status: 200,
      write: { displayName: input.name, displayNameSource: "manual", inferredName: null },
      body: { status: "ok", displayName: input.name }
    };
  }
  // dismiss: clear the suggestion, keep displayName as-is.
  return { status: 200, write: { inferredName: null }, body: { status: "ok" } };
}
