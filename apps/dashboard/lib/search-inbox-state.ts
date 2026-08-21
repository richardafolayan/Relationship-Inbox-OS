import type { InboxResponse } from "./types";

export type SearchInboxPhase = "loading" | "ready" | "refreshing" | "error";

export interface SearchInboxState {
  phase: SearchInboxPhase;
  rows: InboxResponse["rows"];
  hasLoaded: boolean;
}

export function createSearchInboxState(): SearchInboxState {
  return {
    phase: "loading",
    rows: [],
    hasLoaded: false
  };
}

export function beginSearchInboxLoad(state: SearchInboxState): SearchInboxState {
  return {
    ...state,
    phase: state.hasLoaded ? "refreshing" : "loading"
  };
}

export function completeSearchInboxLoad(
  rows: InboxResponse["rows"]
): SearchInboxState {
  return {
    phase: "ready",
    rows,
    hasLoaded: true
  };
}

export function failSearchInboxLoad(state: SearchInboxState): SearchInboxState {
  return {
    ...state,
    phase: "error"
  };
}

export function shouldShowSearchInboxEmptyState(
  state: SearchInboxState,
  hasVisibleResults: boolean
): boolean {
  return state.phase === "ready" && !hasVisibleResults;
}
