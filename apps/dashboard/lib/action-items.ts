// Pure helpers for the thread "things to address" checklist.
//
// Deliberately free of React / Next imports so the logic can be unit-tested
// with the repo's `node --import tsx --test` runner (see
// tests/dashboard-action-items.test.mjs). The localStorage helpers at the
// bottom are guarded so importing this module is safe under SSR and tests.

/**
 * Stable, short, deterministic key for an action item.
 *
 * Keyed off the *source* text so ticked / edited state held in localStorage
 * survives re-renders and re-fetches as long as the underlying open loop is
 * unchanged. Not cryptographic — just a djb2 hash rendered base36.
 */
export function hashActionItem(text: string): string {
  const s = text.trim();
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `ai_${(h >>> 0).toString(36)}`;
}

export interface ManualActionItem {
  id: string;
  text: string;
  checked: boolean;
}

/**
 * Per-thread checklist state. Intentionally small: a thinking aid, not a task
 * model. `checked` and `editedText` are keyed by `hashActionItem` of the
 * source loop; `manualItems` are user-added notes that never touch the
 * server or the message content.
 */
export interface ActionItemChecklistState {
  checked: Record<string, boolean>;
  editedText: Record<string, string>;
  manualItems: ManualActionItem[];
}

export function emptyChecklistState(): ActionItemChecklistState {
  return { checked: {}, editedText: {}, manualItems: [] };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "boolean");
}

function isManualItem(value: unknown): value is ManualActionItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.text === "string" && typeof v.checked === "boolean";
}

/**
 * Tolerant parse of a stored checklist payload. A malformed or stale value
 * never throws — it falls back to empty state — so a bad localStorage entry
 * can't take down the thread page.
 */
export function parseChecklistState(raw: string | null | undefined): ActionItemChecklistState {
  if (!raw) return emptyChecklistState();
  try {
    const parsed = JSON.parse(raw) as Partial<ActionItemChecklistState> | null;
    if (!parsed || typeof parsed !== "object") return emptyChecklistState();
    return {
      checked: isBooleanRecord(parsed.checked) ? parsed.checked : {},
      editedText: isStringRecord(parsed.editedText) ? parsed.editedText : {},
      manualItems: Array.isArray(parsed.manualItems)
        ? parsed.manualItems.filter(isManualItem)
        : []
    };
  } catch {
    return emptyChecklistState();
  }
}

/**
 * The text to display for a source open loop: an operator edit wins over the
 * AI-generated original. A blank/whitespace-only edit is ignored so the
 * original is never lost behind an empty string.
 */
export function resolveItemText(state: ActionItemChecklistState, originalText: string): string {
  const edited = state.editedText[hashActionItem(originalText)];
  if (typeof edited === "string" && edited.trim().length > 0) return edited;
  return originalText;
}

export const ACTION_ITEMS_STORAGE_PREFIX = "relationship-inbox-os:thread-action-items:";

export function actionItemsStorageKey(threadId: string): string {
  return `${ACTION_ITEMS_STORAGE_PREFIX}${threadId}`;
}

/** ID for a user-added manual item. Unique enough for a per-thread checklist. */
export function newManualItemId(): string {
  return `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Load checklist state for a thread. Returns empty state outside the browser. */
export function loadChecklistState(threadId: string): ActionItemChecklistState {
  if (typeof window === "undefined") return emptyChecklistState();
  try {
    return parseChecklistState(window.localStorage.getItem(actionItemsStorageKey(threadId)));
  } catch {
    return emptyChecklistState();
  }
}

/** Persist checklist state for a thread. No-op outside the browser. */
export function saveChecklistState(threadId: string, state: ActionItemChecklistState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(actionItemsStorageKey(threadId), JSON.stringify(state));
  } catch {
    // localStorage can throw (quota / privacy mode). The checklist is a
    // thinking aid, so a failed persist is silently non-fatal.
  }
}
