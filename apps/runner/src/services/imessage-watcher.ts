import { type FSWatcher, watch } from "node:fs";
import { dirname, basename } from "node:path";

export interface IMessageWatcherDeps {
  dbPath: string;
  debounceMs: number;
  /** Called once per debounced burst of chat.db / WAL / SHM writes. */
  onChange: (reason: string) => void;
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
  let stopped = false;
  // Track every scheduled re-arm so `stop()` can cancel them. Previously a
  // pending `setTimeout(attach, 1000)` would still fire after `stop()` set
  // `stopped=true`, installing a fresh watcher the caller could never see
  // to clean up. The check at the top of attach() now also looks at
  // `stopped` but cancelling the timer is the defence in depth.
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function scheduleAttach(delayMs: number): void {
    if (stopped) return;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      attach();
    }, delayMs);
    pendingTimers.add(timer);
  }

  function fireDebounced(): void {
    const reason = pendingReason ?? "unknown";
    pendingReason = null;
    debounceTimer = null;
    if (stopped) return;
    try {
      deps.onChange(reason);
    } catch (error) {
      log(`[imessage-watcher] onChange threw: ${(error as Error).message ?? error}`);
    }
  }

  function armDebounce(reason: string): void {
    if (stopped) return;
    pendingReason = reason;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(fireDebounced, deps.debounceMs);
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
        log(`[imessage-watcher] watcher error: ${error.message}; re-arming in 1s`);
        watcher?.close();
        watcher = undefined;
        scheduleAttach(1_000);
      });
      log(`[imessage-watcher] armed on ${watchDir} (debounce ${deps.debounceMs}ms)`);
    } catch (error) {
      log(`[imessage-watcher] failed to arm watcher: ${(error as Error).message}; retrying in 5s`);
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
      // Cancel any scheduled re-arms so a watcher can't be installed AFTER
      // the caller asked us to stop.
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        pendingReason = null;
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
