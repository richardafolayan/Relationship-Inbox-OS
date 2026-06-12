// Headline line shown under a person's name in the People list.
//
// Fallback order:
//   1. an explicit profile headline, else
//   2. "<role> at <company>" (whichever parts exist), else
//   3. the "no profile yet" placeholder.
//
// NOTE: `Array.prototype.join` always returns a string — an empty filtered
// array joins to "", which is non-nullish. A `??` after the join therefore
// never reaches the placeholder, so a person with no role/company rendered an
// EMPTY headline. We use `||` on the joined value so the empty-string case
// falls through to "no profile yet". (The detail panel uses the same `|| null`
// idiom — keep them consistent.)

export interface PersonHeadlineFields {
  headline?: string | null;
  currentRole?: string | null;
  currentCompany?: string | null;
}

export function personHeadlineLine(person: PersonHeadlineFields): string {
  const headline = person.headline?.trim();
  if (headline) return headline;

  const roleCompany = [person.currentRole, person.currentCompany]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" at ");

  return roleCompany || "no profile yet";
}
