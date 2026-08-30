// A monotonic request gate for stale-response guarding.
//
// `createLatestRequestGate` hands out strictly-increasing tokens via `next()`;
// `isLatest(token)` is true only for the most recently issued token. Used to
// drop out-of-order async responses — e.g. switching People quickly, where an
// earlier detail fetch may resolve after a later one — so only the latest
// response is allowed to write to state.
export interface LatestRequestGate {
  /** Issue a new token and make it the latest. */
  next(): number;
  /** True only if `token` is the most recently issued token. */
  isLatest(token: number): boolean;
}

export interface LatestKeyedRequestGate<Key> {
  next(key: Key): number;
  isLatest(key: Key, token: number): boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isLatest(token: number): boolean {
      return token === latest;
    },
  };
}

export function createLatestKeyedRequestGate<Key = string>(): LatestKeyedRequestGate<Key> {
  const latestByKey = new Map<Key, number>();
  return {
    next(key: Key): number {
      const token = (latestByKey.get(key) ?? 0) + 1;
      latestByKey.set(key, token);
      return token;
    },
    isLatest(key: Key, token: number): boolean {
      return latestByKey.get(key) === token;
    },
  };
}
