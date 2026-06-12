/**
 * Apple-Messages-style reply threading: pure render decisions for the
 * thread transcript.
 *
 * The transcript mirrors Messages.app's inline-reply affordances:
 *   - a reply renders beneath a small translucent quote of its parent
 *     (aligned to the PARENT sender's side) connected by a curved tail;
 *   - consecutive replies to the same parent render as a continuation
 *     run - the quote + curve appear only on the first of the run;
 *   - a reply sitting directly under its parent skips the quote (the
 *     parent bubble itself is the context) but keeps the curve;
 *   - any message with replies gets an "N Replies" link under the
 *     bubble; a rendered quote also gets one when the parent has 2+
 *     replies (Apple shows the count between the quote and the reply).
 *
 * Two linkage sources are unified here (same precedence as the runner):
 *   1. `replyToMessageId` - app-level threading, a parent Message.id
 *      cuid set by the dashboard's focused-thread composer;
 *   2. `raw.replyToGuid` - Apple-native chat.db
 *      `thread_originator_guid`, resolved against another row's
 *      `platformMessageKey`.
 *
 * Everything is computed over the loaded message window. A reply whose
 * parent lives outside the window still decorates (quote text comes from
 * the server-resolved `replyTo` snippet) but is not navigable and its
 * parent's count only covers in-window replies - PM-accepted v1 trade-off
 * (2026-06-12): exact global counts would need a rawJson scan per request.
 */

export interface ReplyThreadingMessage {
  id: string;
  direction: "IN" | "OUT";
  platformMessageKey?: string | null;
  replyToMessageId?: string | null;
  raw?: Record<string, unknown> | null;
  /** Server-resolved parent stub for parents outside the loaded window. */
  replyTo?: { messageId?: string; snippet: string; direction?: "IN" | "OUT" } | null;
}

export interface ReplyGraph {
  /** childId -> parentId, only when the parent is in the window. */
  parentIdOf: Map<string, string>;
  /**
   * childId -> stable parent key for EVERY reply, resolved or not.
   * Resolved parents key as `id:<cuid>`; unresolved fall back to the
   * raw pointer (`guid:<guid>` / `cuid:<cuid>`) so two siblings citing
   * the same out-of-window parent still group into one run.
   */
  parentKeyOf: Map<string, string>;
  /** parent key -> number of in-window replies. */
  replyCountByParentKey: Map<string, number>;
  /** parentId -> ordered child ids (in-window, resolved parents only). */
  replyChildIdsByParentId: Map<string, string[]>;
}

function rawReplyToGuid(m: ReplyThreadingMessage): string | null {
  const guid = (m.raw as { replyToGuid?: unknown } | null | undefined)?.replyToGuid;
  return typeof guid === "string" && guid.length > 0 ? guid : null;
}

/** True when the message carries any reply pointer at all. */
export function hasReplyIntent(m: ReplyThreadingMessage): boolean {
  return Boolean(m.replyToMessageId) || rawReplyToGuid(m) !== null;
}

/**
 * Build the reply graph for a chronological window of visible messages.
 * `replyToMessageId` (app-level) wins over `raw.replyToGuid` when both
 * are present, matching the runner's resolution order.
 */
export function buildReplyGraph(messages: ReplyThreadingMessage[]): ReplyGraph {
  const byId = new Map<string, ReplyThreadingMessage>();
  const byKey = new Map<string, ReplyThreadingMessage>();
  for (const m of messages) {
    byId.set(m.id, m);
    if (m.platformMessageKey) byKey.set(m.platformMessageKey, m);
  }
  const parentIdOf = new Map<string, string>();
  const parentKeyOf = new Map<string, string>();
  const replyCountByParentKey = new Map<string, number>();
  const replyChildIdsByParentId = new Map<string, string[]>();
  for (const m of messages) {
    let parentId: string | undefined;
    let fallbackKey: string | undefined;
    if (m.replyToMessageId) {
      if (byId.has(m.replyToMessageId)) parentId = m.replyToMessageId;
      else fallbackKey = `cuid:${m.replyToMessageId}`;
    } else {
      const guid = rawReplyToGuid(m);
      if (guid) {
        const parent = byKey.get(guid);
        if (parent) parentId = parent.id;
        else fallbackKey = `guid:${guid}`;
      }
    }
    // A row citing itself (corrupt pointer) renders as a plain bubble
    // rather than an infinite self-thread.
    if (parentId === m.id) continue;
    if (parentId) {
      parentIdOf.set(m.id, parentId);
      parentKeyOf.set(m.id, `id:${parentId}`);
      const list = replyChildIdsByParentId.get(parentId) ?? [];
      list.push(m.id);
      replyChildIdsByParentId.set(parentId, list);
    } else if (fallbackKey) {
      parentKeyOf.set(m.id, fallbackKey);
    } else {
      continue;
    }
    const key = parentKeyOf.get(m.id)!;
    replyCountByParentKey.set(key, (replyCountByParentKey.get(key) ?? 0) + 1);
  }
  return { parentIdOf, parentKeyOf, replyCountByParentKey, replyChildIdsByParentId };
}

export interface ReplyDecor {
  /** Message carries a reply pointer (its bubble belongs to a thread). */
  isReply: boolean;
  /** Resolved in-window parent id; null when out of window. Navigable when set. */
  parentId: string | null;
  /**
   * Side the quote/curve lean toward - the parent sender's direction.
   * Resolved parent wins; falls back to the server stub, then to the
   * opposite of the reply's own side (most replies answer the other
   * party).
   */
  parentDirection: "IN" | "OUT";
  /** Render the translucent quoted-parent mini bubble above this message. */
  showQuote: boolean;
  /** Render the curved connector tail on this bubble (first of a run). */
  showCurve: boolean;
  /** In-window replies to THIS message - drives the under-bubble link. */
  replyCount: number;
  /** In-window replies to this message's PARENT (under-quote link label). */
  parentReplyCount: number;
  /** Apple shows the count between quote and reply only when 2+. */
  showQuoteReplyCount: boolean;
}

/**
 * Per-message render decisions for a chronological window of visible
 * messages. Pass the graph from `buildReplyGraph` when you already have
 * it (the page memoizes it for the focused-thread overlay); otherwise it
 * is built internally.
 */
export function computeReplyDecor(
  messages: ReplyThreadingMessage[],
  graph: ReplyGraph = buildReplyGraph(messages)
): Map<string, ReplyDecor> {
  const byId = new Map<string, ReplyThreadingMessage>();
  for (const m of messages) byId.set(m.id, m);
  const decors = new Map<string, ReplyDecor>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const replyCount = graph.replyCountByParentKey.get(`id:${m.id}`) ?? 0;
    const parentKey = graph.parentKeyOf.get(m.id);
    if (!parentKey) {
      decors.set(m.id, {
        isReply: false,
        parentId: null,
        parentDirection: m.direction === "OUT" ? "IN" : "OUT",
        showQuote: false,
        showCurve: false,
        replyCount,
        parentReplyCount: 0,
        showQuoteReplyCount: false
      });
      continue;
    }
    const parentId = graph.parentIdOf.get(m.id) ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    const parentDirection: "IN" | "OUT" =
      parent?.direction ??
      m.replyTo?.direction ??
      (m.direction === "OUT" ? "IN" : "OUT");
    const parentReplyCount = graph.replyCountByParentKey.get(parentKey) ?? 0;
    const prev = i > 0 ? messages[i - 1] : undefined;
    // Continuation: the previous bubble is a reply in the same thread -
    // render plain, the run's first bubble already drew the context.
    const continuation = prev ? graph.parentKeyOf.get(prev.id) === parentKey : false;
    // Adjacent: the parent bubble itself sits directly above - the
    // quote would duplicate it, but the curve still ties them together.
    const adjacentToParent = prev ? parentId !== null && prev.id === parentId : false;
    const showQuote = !continuation && !adjacentToParent;
    const showCurve = !continuation;
    decors.set(m.id, {
      isReply: true,
      parentId,
      parentDirection,
      showQuote,
      showCurve,
      replyCount,
      parentReplyCount,
      showQuoteReplyCount: showQuote && parentReplyCount >= 2
    });
  }
  return decors;
}

/** "1 Reply" / "3 Replies" - ASCII only (release gate bans dashes too). */
export function formatReplyCount(n: number): string {
  return `${n} ${n === 1 ? "Reply" : "Replies"}`;
}
