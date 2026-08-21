export interface InboxCacheKeyInput {
  archived: boolean;
  needsReply: boolean;
  platform?: string;
  risk?: string;
  search?: string;
  unread: boolean;
}

export function createInboxCacheKey(input: InboxCacheKeyInput): string {
  return JSON.stringify([
    input.archived,
    input.needsReply,
    input.platform ?? "",
    input.risk ?? "",
    input.search ?? "",
    input.unread
  ]);
}

export class BoundedLruCache<Value> {
  readonly #entries = new Map<string, Value>();

  constructor(readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): Value | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function createSingleFlight<Value>() {
  const running = new Map<string, Promise<Value>>();
  return {
    get size(): number {
      return running.size;
    },
    has(key: string): boolean {
      return running.has(key);
    },
    run(key: string, work: () => Promise<Value>): Promise<Value> {
      const existing = running.get(key);
      if (existing) return existing;
      const pending = work();
      running.set(key, pending);
      void pending.finally(() => {
        if (running.get(key) === pending) running.delete(key);
      }).catch(() => undefined);
      return pending;
    }
  };
}
