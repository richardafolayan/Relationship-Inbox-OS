// JID parsing for whatsapp-web.js identifiers. WhatsApp encodes contact
// and group identity as JIDs (Jabber IDs):
//   1:1 conversations: <country-and-number>@c.us  e.g. 447111222333@c.us
//   group conversations: <creator-id>-<created-at>@g.us  e.g. 12345-67890@g.us
//   broadcast / status: <id>@broadcast | status@broadcast (not handled in v1)
// The "@c.us" / "@g.us" suffix is what disambiguates 1:1 vs group at the
// identity layer; chat.isGroup mirrors this on the wweb.js Chat object.

export type JidKind = "contact" | "group" | "broadcast" | "unknown";

export interface ParsedJid {
  raw: string;
  kind: JidKind;
  /** Local part before the "@" — phone number for contacts, group id for groups. */
  local: string;
  domain: string;
}

export function parseJid(jid: string | null | undefined): ParsedJid | null {
  if (!jid) return null;
  const trimmed = jid.trim();
  if (trimmed.length === 0) return null;
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  let kind: JidKind = "unknown";
  if (domain === "c.us" || domain === "s.whatsapp.net") kind = "contact";
  else if (domain === "g.us") kind = "group";
  else if (domain === "broadcast") kind = "broadcast";
  return { raw: trimmed, kind, local, domain };
}

/** True if this JID is a group identifier (ends with `@g.us`). */
export function isGroupJid(jid: string | null | undefined): boolean {
  return parseJid(jid)?.kind === "group";
}

/** True if this JID is a 1:1 contact identifier (ends with `@c.us` or `@s.whatsapp.net`). */
export function isContactJid(jid: string | null | undefined): boolean {
  return parseJid(jid)?.kind === "contact";
}

/**
 * Extract the phone number from a contact JID. Returns null for groups,
 * broadcasts, or malformed JIDs. The number is digits-only with no
 * country-code prefix punctuation — useful for display ("+44 7111…")
 * once formatted at the UI boundary.
 */
export function jidToPhoneNumber(jid: string | null | undefined): string | null {
  const parsed = parseJid(jid);
  if (!parsed || parsed.kind !== "contact") return null;
  // Strip a possible device suffix (`447111:42@c.us`) used by linked devices.
  // `split(":")[0]` is `string | undefined` under strict mode even though it
  // can never be undefined for a non-empty input — fall back to `local` to
  // satisfy the type checker without changing behaviour.
  const beforeColon = parsed.local.split(":")[0] ?? parsed.local;
  return /^\d+$/.test(beforeColon) ? beforeColon : null;
}

/**
 * Round-trip a phone number back to the canonical JID form. Used when the
 * adapter has a number from a Person.handle or env var and needs to call
 * a wweb.js API that takes a JID. Matches the `<digits>@c.us` shape
 * wweb.js itself emits for contact chats.
 */
export function phoneNumberToContactJid(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  return `${digits}@c.us`;
}
