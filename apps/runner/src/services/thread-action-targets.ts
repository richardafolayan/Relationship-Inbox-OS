import type { PlatformName } from "@inbox-os/core";

export interface ThreadActionPrismaSurface {
  thread: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; platform: true; personId: true };
    }): Promise<{ id: string; platform: PlatformName; personId: string } | null>;
    findMany(args: {
      where: { platform: PlatformName; personId: string };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

/**
 * Resolves the set of thread ids an inbox-row action (snooze, mark-done,
 * archive, unarchive) should target.
 *
 * For iMessage, the dashboard collapses sibling chats (phone-handle and
 * email-handle threads with the same person) into one row per Person.
 * Acting on a single sibling lets the other sibling resurface on the
 * next refresh, which looks like the row never got snoozed/archived
 * (issue #252). Propagate the action to every sibling so the row
 * actually leaves the visible inbox.
 *
 * For other platforms each thread renders as its own row, so the action
 * stays scoped to the single thread id it was called for.
 */
export async function resolveActionTargetThreadIds(
  prisma: ThreadActionPrismaSurface,
  threadId: string
): Promise<string[]> {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, platform: true, personId: true }
  });
  if (!thread) return [threadId];
  if (thread.platform === "IMESSAGE") {
    const siblings = await prisma.thread.findMany({
      where: { platform: thread.platform, personId: thread.personId },
      select: { id: true }
    });
    return siblings.length > 0 ? siblings.map((row) => row.id) : [thread.id];
  }
  return [thread.id];
}
