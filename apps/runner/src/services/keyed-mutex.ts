type MutexWork<T> = () => Promise<T>;

interface QueueEntry<T> {
  run: MutexWork<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<T>;
}

interface KeyState {
  running: boolean;
  queue: Array<QueueEntry<unknown>>;
  queueOnePending?: QueueEntry<unknown>;
}

function createQueueEntry<T>(work: MutexWork<T>): QueueEntry<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    run: work,
    resolve,
    reject,
    promise
  };
}

/**
 * Serializes async work per key.
 * - `runExclusive` always enqueues.
 * - `runWithQueueOne` collapses concurrent queued requests to a single pending run.
 */
export class KeyedMutex {
  private readonly states = new Map<string, KeyState>();

  async runExclusive<T>(key: string, work: MutexWork<T>): Promise<T> {
    return this.enqueue(key, work, "all");
  }

  async runWithQueueOne<T>(key: string, work: MutexWork<T>): Promise<T> {
    return this.enqueue(key, work, "queue_one");
  }

  getQueueDepth(key?: string): number {
    if (key) {
      const state = this.states.get(key);
      if (!state) {
        return 0;
      }
      return (state.running ? 1 : 0) + state.queue.length;
    }

    let depth = 0;
    for (const state of this.states.values()) {
      depth += (state.running ? 1 : 0) + state.queue.length;
    }
    return depth;
  }

  isRunning(key: string): boolean {
    return this.states.get(key)?.running ?? false;
  }

  /**
   * Attempt to run `work` only if no holder is currently active for `key`.
   * Resolves with `{ acquired: true, value }` on success and
   * `{ acquired: false }` synchronously when the lock is held.
   *
   * Used by enrichment-queue to yield to live scan/send work without
   * queueing behind it — a queued profile visit could sit for minutes
   * behind a scan, causing pacing skew. With this, the worker simply
   * defers the job and tries the next slot on the next tick.
   */
  async tryAcquire<T>(key: string, work: MutexWork<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const state = this.states.get(key);
    if (state?.running) {
      return { acquired: false };
    }
    const value = await this.runExclusive(key, work);
    return { acquired: true, value };
  }

  private enqueue<T>(key: string, work: MutexWork<T>, mode: "all" | "queue_one"): Promise<T> {
    const state = this.states.get(key) ?? {
      running: false,
      queue: []
    };
    this.states.set(key, state);

    if (mode === "queue_one" && state.running && state.queueOnePending) {
      return state.queueOnePending.promise as Promise<T>;
    }

    const entry = createQueueEntry(work);
    state.queue.push(entry as QueueEntry<unknown>);
    if (mode === "queue_one" && state.running) {
      state.queueOnePending = entry as QueueEntry<unknown>;
    }

    if (!state.running) {
      state.running = true;
      void this.drain(key, state);
    }

    return entry.promise;
  }

  private async drain(key: string, state: KeyState): Promise<void> {
    while (state.queue.length > 0) {
      const entry = state.queue.shift();
      if (!entry) {
        break;
      }

      if (state.queueOnePending === entry) {
        state.queueOnePending = undefined;
      }

      try {
        const value = await entry.run();
        entry.resolve(value);
      } catch (error) {
        entry.reject(error);
      }
    }

    state.running = false;
    if (state.queue.length === 0) {
      this.states.delete(key);
    }
  }
}

export function createKeyedMutex(): KeyedMutex {
  return new KeyedMutex();
}
