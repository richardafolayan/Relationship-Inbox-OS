// Pure helpers for iMessage group-name handling, shared by the adapter,
// the manual-import path, and the scan-queue upsert. Kept side-effect-free
// so the no-clobber invariant can be unit-tested without a chat.db or a
// Prisma client (mirrors linkedin-inflight-guard.ts).

/**
 * Derive the group-specific ThreadStub fields from a chat.db row. The
 * group name is the operator-set chat name (`userSetName`) and only exists
 * for named groups — a 1:1 or an unnamed group yields `undefined`, so the
 * downstream refresh never tries to stamp a non-name onto a person.
 */
export function groupStubFields(row: {
  isGroup: boolean;
  userSetName: string | null;
}): { isGroup: boolean; groupName: string | undefined } {
  return {
    isGroup: row.isGroup,
    groupName: row.isGroup && row.userSetName ? row.userSetName : undefined
  };
}

/**
 * The no-clobber decision for refreshing a group thread's synthetic-Person
 * displayName from the platform-authoritative chat name. Returns true only
 * when there is a real group name that differs from what's stored AND the
 * stored name was not set by the operator. Mirrors the profileUrl
 * provenance rule: a manual ("manual") value is never overwritten by an
 * auto refresh.
 */
export function shouldRefreshGroupDisplayName(args: {
  isGroup?: boolean;
  groupName?: string;
  currentDisplayName: string;
  currentSource: string | null;
}): boolean {
  const { isGroup, groupName, currentDisplayName, currentSource } = args;
  if (!isGroup) return false;
  if (typeof groupName !== "string" || groupName.length === 0) return false;
  if (currentSource === "manual") return false;
  return currentDisplayName !== groupName;
}
