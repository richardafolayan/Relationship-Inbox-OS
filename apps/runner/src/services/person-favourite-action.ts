// Pure decision logic for POST /control/person/:personId/favourite (R-0066 /
// #483 — operator-pinned favourite contacts).
//
// Extracted from the route handler so the toggle/idempotency rules are unit
// testable (the handler boots the whole runner + Prisma, which is not). The
// handler stays a thin shell: look up the person, call this, apply `write`
// (if any), then send `status` + `body`.

export interface PersonFavouriteActionInput {
  /**
   * "set" applies `favourite` verbatim; "toggle" (the default when neither is
   * given) flips the current state. The dashboard sends an explicit
   * `favourite` so an optimistic star can't drift out of sync on a double
   * click; a bare POST still toggles for convenience.
   */
  action?: "toggle" | "set";
  /** Desired state for "set"; also implies "set" when present. */
  favourite?: boolean;
}

/** The subset of a Person this decision reads. */
export interface PersonFavouriteSubject {
  favouritedAt: Date | null;
}

export interface PersonFavouriteActionDecision {
  /** HTTP status the handler should return. */
  status: number;
  /**
   * Prisma `data` for `person.update`, or `null` when no write is needed (the
   * contact is already in the requested state — an idempotent no-op).
   */
  write: { favouritedAt: Date | null } | null;
  /** JSON body to send back; `favourite` is the resulting state. */
  body: { status: "ok"; favourite: boolean };
}

export function decidePersonFavouriteAction(
  person: PersonFavouriteSubject,
  input: PersonFavouriteActionInput,
  now: Date = new Date()
): PersonFavouriteActionDecision {
  const current = person.favouritedAt != null;
  const next =
    input.action === "set" || typeof input.favourite === "boolean"
      ? input.favourite === true
      : !current;

  // Idempotent: setting a contact to the state they're already in is a
  // successful no-op with no DB write (mirrors the rename "confirm" path).
  if (next === current) {
    return { status: 200, write: null, body: { status: "ok", favourite: current } };
  }

  return {
    status: 200,
    write: { favouritedAt: next ? now : null },
    body: { status: "ok", favourite: next }
  };
}
