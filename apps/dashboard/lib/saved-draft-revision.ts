export interface SavedDraftRevision {
  text: string;
  updatedAt: string;
}

export interface SaveDraftResponse {
  status: "ok";
  draft: SavedDraftRevision;
}

export function mergeSavedDraftRevision<
  T extends { id: string; draft: string; draftUpdatedAt: string | null }
>(current: T | null, threadId: string, saved: SavedDraftRevision): T | null {
  if (!current || current.id !== threadId) return current;
  return {
    ...current,
    draft: saved.text,
    draftUpdatedAt: saved.updatedAt
  };
}
