import { type FSWatcher, watch } from "node:fs";
import { dirname, basename } from "node:path";

export interface IMessageWatcherDeps {
  dbPath: string;
  debounceMs: number;
  /** Called once per debounced burst of chat.db / WAL / SHM writes. */
  onChange: (change: { reason: string; sourceChangedAt: string }) => void;
  /** Optional logger; falls back to console.log. */
  log?: (line: string) => void;
}

export interface IMessageWatcher {
  start(): void;
  stop(): void;
  /** Test seam — forces the debounce timer to fire now if armed. */
  flushDebounceForTest(): void;
}

/**
 * Real-time chat.db watcher for the iMessage adapter.
 *
 * SQLite's WAL mode means Messages.app writes new messages to
 * `chat.db-wal` first; the main `chat.db` is only touched on checkpoint
 * (every few minutes, or at app exit). Watching the parent directory
 * catches both, plus the `chat.db-shm` shared-memory file, plus the
 * recreation that happens when SQLite rotates the WAL — `fs.watch` on
 * the file itself would silently detach on rotation.
 *
 * We don't tail the DB ourselves; on each debounced burst we just nudge
 * the existing scan-queue. That keeps the diff small and reuses all the
 * existing dedupe / ingest / receipt machinery.
 */
export function createIMessageWatcher(deps: IMessageWatcherDeps): IMessageWatcher {
  const log = deps.log ?? ((line) => console.log(line));
  const watchDir = dirname(deps.dbPath);
  const dbBase = basename(deps.dbPath);
  const tracked = new Set([dbBase, `${dbBase}-wal`, `${dbBase}-shm`]);

  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason: string | null = null;
  let pendingSourceChangedAt: string | null = null;
  let reattachTimer: ReturnType<typeof setTimeout> | null = null;
  let reattachAttempts = 0;
  let stopped = false;

  function fireDebounced(): void {
    const reason = pendingReason ?? "unknown";
    const sourceChangedAt = pendingSourceChangedAt ?? new Date().toISOString();
    pendingReason = null;
    pendingSourceChangedAt = null;
    debounceTimer = null;
    try {
      deps.onChange({ reason, sourceChangedAt });
    } catch (error) {
      log(`[imessage-watcher] onChange threw: ${(error as Error).message ?? error}`);
    }
  }

  function armDebounce(reason: string): void {
    pendingReason = reason;
    pendingSourceChangedAt ??= new Date().toISOString();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(fireDebounced, deps.debounceMs);
    debounceTimer.unref?.();
  }

  function scheduleAttach(baseDelayMs: number): void {
    if (stopped || reattachTimer) return;
    const delayMs = Math.min(60_000, baseDelayMs * 2 ** Math.min(reattachAttempts, 5));
    reattachAttempts += 1;
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      attach();
    }, delayMs);
    reattachTimer.unref?.();
  }

  function attach(): void {
    if (stopped) return;
    try {
      watcher = watch(watchDir, { persistent: false }, (_eventType, filename) => {
        if (!filename) return;
        if (!tracked.has(filename.toString())) return;
        armDebounce(filename.toString());
      });
      watcher.on("error", (error) => {
        log(`[imessage-watcher] watcher error: ${error.message}; re-arming with backoff`);
        watcher?.close();
        watcher = undefined;
        scheduleAttach(1_000);
      });
      reattachAttempts = 0;
      log(`[imessage-watcher] armed on ${watchDir} (debounce ${deps.debounceMs}ms)`);
    } catch (error) {
      log(`[imessage-watcher] failed to arm watcher: ${(error as Error).message}; retrying with backoff`);
      scheduleAttach(5_000);
    }
  }

  return {
    start(): void {
      if (watcher) return;
      stopped = false;
      attach();
    },
    stop(): void {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        pendingReason = null;
        pendingSourceChangedAt = null;
      }
      if (reattachTimer) {
        clearTimeout(reattachTimer);
        reattachTimer = null;
      }
      watcher?.close();
      watcher = undefined;
    },
    flushDebounceForTest(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        fireDebounced();
      }
    }
  };
}
