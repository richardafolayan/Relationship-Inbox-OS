import {
  sameThreadComposerIntent,
  type ThreadComposerIntentDraft
} from "./thread-composer-session";

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

export function mergeDeletedDraftRevision<
  T extends { id: string; draft: string; draftUpdatedAt: string | null }
>(current: T | null, threadId: string): T | null {
  if (!current || current.id !== threadId) return current;
  return {
    ...current,
    draft: "",
    draftUpdatedAt: null
  };
}

export function draftRevisionForComposerSend(
  _currentRevision: SavedDraftRevision | null,
  originatingRevision: SavedDraftRevision | null
): SavedDraftRevision | null {
  return originatingRevision;
}

export function shouldClearComposerAfterDraftDelete(
  activeThreadId: string,
  targetThreadId: string,
  currentIntent: ThreadComposerIntentDraft,
  capturedIntent: ThreadComposerIntentDraft,
  deletedRevision: SavedDraftRevision | null
): boolean {
  return Boolean(
    deletedRevision &&
      activeThreadId === targetThreadId &&
      sameThreadComposerIntent(currentIntent, capturedIntent) &&
      capturedIntent.text === deletedRevision.text &&
      capturedIntent.attachments.length === 0 &&
      capturedIntent.replyToMessageId === null &&
      !capturedIntent.customScheduleValue
  );
}
