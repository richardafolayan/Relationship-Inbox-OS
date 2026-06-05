// Immediate per-thread reassess when the operator sends a reply.
//
// Why this exists: the reply brief (rollingSummary / whatTheyWant / open_loops
// / reply_brief) only recomputes when the scan loop sees the thread's
// lastInboundHash change. A new inbound message and a phone-side reply both
// flip that hash on the next scan, so they reassess — eventually. But a
// DASHBOARD send goes straight through send.ts: it persists the OUT message,
// flips needsReply=false, and emits MESSAGE_SENT, yet nothing recomputes the
// brief. The right rail then shows what the operator JUST replied to as still
// outstanding until the next scan happens to run.
//
// Richard's ask: "every time I receive a new message or I send one, the AI
// should reassess the chat, so I can see what I've replied to and what still
// needs a reply." Inbound stays scan-driven (the scan reassesses inline on
// detection; there is no push channel for iMessage / LinkedIn). This module
// closes the send-side gap by reassessing immediately on MESSAGE_SENT.
//
// Extracted from index.ts so the dedupe / failure / timeout behaviour is unit
// testable without booting Express, mirroring resummarize-thread.ts and
// reassess-thread.ts.

/** Minimal event shape this handler reacts to. Compatible with RunnerEvent. */
export interface ReassessTriggerEvent {
  type: string;
  threadId?: string;
}

export interface ReassessOnSendDeps {
  /**
   * Re-run the thread summary/brief pipeline for one thread. In production
   * this is resummarizeThreadById; in tests it's a fake. Resolves to the
   * resummarizeThread result (only `ok` is read here).
   */
  resummarize: (threadId: string) => Promise<{ ok: boolean }>;
  /**
   * Called after a SUCCESSFUL reassess so the caller can emit THREAD_UPDATED
   * and the dashboard refetches the rail. Not called on failure / not-found.
   */
  onReassessed?: (threadId: string) => void;
  /** Non-blocking failure hook (log). Never throws back into the event loop. */
  onError?: (threadId: string, error: unknown) => void;
  /**
   * Hard ceiling so a hung provider can't glue a thread to the in-flight map
   * forever (mirrors index.ts's withInFlightTimeout). Defaults to 120s.
   */
  timeoutMs?: number;
}

export interface ReassessOnSendHandler {
  /**
   * Pass to eventBus.subscribe. On MESSAGE_SENT it kicks a background
   * reassess for the thread. Returns synchronously — never blocks the event
   * loop or the send path.
   */
  handle: (event: ReassessTriggerEvent) => void;
  /** Thread ids with a reassess currently in flight (inspection / tests). */
  readonly inFlight: ReadonlyMap<string, Promise<void>>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function createReassessOnSendHandler(deps: ReassessOnSendDeps): ReassessOnSendHandler {
  const inFlight = new Map<string, Promise<void>>();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function handle(event: ReassessTriggerEvent): void {
    if (event.type !== "MESSAGE_SENT") return;
    const threadId = event.threadId;
    if (!threadId) return;
    // Coalesce a burst of sends to the same thread: one reassess at a time.
    // A send that lands while a reassess is mid-flight is covered by the
    // scan backstop (and by the next send) — we never queue duplicates.
    if (inFlight.has(threadId)) return;

    const work = (async () => {
      const result = await deps.resummarize(threadId);
      if (result.ok) deps.onReassessed?.(threadId);
    })();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const guarded: Promise<void> = Promise.race([
      work,
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`reassess-on-send(${threadId}) exceeded ${timeoutMs}ms; abandoning in-flight slot`)),
          timeoutMs
        );
      })
    ])
      .catch((error: unknown) => {
        deps.onError?.(threadId, error);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        // Only clear if it's still our promise (a later send may have set a
        // new one after we resolved — though the has() guard makes that rare).
        if (inFlight.get(threadId) === guarded) inFlight.delete(threadId);
      });

    inFlight.set(threadId, guarded);
  }

  return {
    handle,
    get inFlight() {
      return inFlight;
    }
  };
}
