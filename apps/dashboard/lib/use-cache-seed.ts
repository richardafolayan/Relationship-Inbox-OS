"use client";

// Hydration-safe page seeding from the shared client response cache.
//
// Pages seed their initial state from lib/api's response cache so a
// client-side navigation (back from a thread, Today <-> Inbox) paints the
// last-known data instantly instead of a skeleton. Doing that with a
// `useState(() => peekCache(...))` initializer is a hydration hazard: on a
// hard load the app shell hydrates first and its effects call apiGet, which
// seeds the in-memory cache from the localStorage snapshot BEFORE the page's
// own boundary hydrates. The page's first client render then shows cached
// data while the server-rendered HTML shows the empty state, React reports
// "Hydration failed because the server rendered text didn't match the
// client" and regenerates the whole tree client-side.
//
// useSyncExternalStore is React's primitive for exactly this contract:
//   * server render + hydration render read getServerSnapshot (always
//     undefined here, matching the server HTML by construction), then React
//     re-checks getSnapshot after hydration and re-renders with the cached
//     value - no mismatch, no thrown-away tree;
//   * client-side navigation mounts are not hydration, so the first render
//     reads getSnapshot directly and the instant paint is preserved.
//
// The subscribe callback is intentionally inert: the seed only needs to be
// current at mount. Pages own their data lifecycle afterwards (refresh()
// fetches into useState), so cache writes never need to re-render through
// this store. Derive the rendered value as `state ?? seed` instead of
// copying the seed into state.

import { useSyncExternalStore } from "react";
import { peekCache } from "./api";

const subscribeNever = () => () => {};

/**
 * Read the last cached value for a path (undefined if none) in a way that is
 * safe to render during hydration. Use this INSTEAD of peekCache inside a
 * useState initializer - the useState form leaks warm-cache data into the
 * hydration render and mismatches the server HTML.
 *
 * Not suitable as-is for state that is mutated with functional updaters
 * (setX(prev => ...)): with the `state ?? seed` pattern those updaters see
 * `prev = null` while the UI is showing the seed. (The thread page keeps its
 * useState initializer for this reason - see the comment there.)
 */
export function useCacheSeed<T>(path: string): T | undefined {
  return useSyncExternalStore(
    subscribeNever,
    () => peekCache<T>(path),
    () => undefined
  );
}
