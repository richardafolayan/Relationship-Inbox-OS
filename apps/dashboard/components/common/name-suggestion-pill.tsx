"use client";

import { useEffect, useRef, useState } from "react";
import { apiPost, runAction } from "@/lib/api";

interface NameSuggestionPillProps {
  personId: string;
  /**
   * - When set, renders as "Maybe <name>" with confirm / edit / dismiss
   *   options. The operator hasn't yet promoted or rejected this guess.
   * - When null, renders as a subtle edit affordance (a small pencil-style
   *   pill). Only the rename action is offered. Used to let the operator
   *   correct an already-confirmed name (e.g. the heuristic was wrong).
   */
  inferredName: string | null;
  /** Current displayName - pre-fills the edit box when no inferredName is set. */
  currentName?: string;
  /** Called after a successful confirm/rename/dismiss so the parent can re-fetch. */
  onChanged: () => void;
}

/**
 * Small "Maybe Marianne" pill that opens a popover with three actions:
 *   - Use this name        → confirm; promotes inferredName to displayName
 *   - Edit name…           → inline text input; rename to a custom value
 *   - Reject               → dismiss; clears the inferredName silently
 *
 * Designed to render inside a clickable row (Link wrapper) - every handler
 * stops propagation and prevents default so a click on the pill never
 * navigates to the thread.
 */
export function NameSuggestionPill({ personId, inferredName, currentName, onChanged }: NameSuggestionPillProps) {
  const editOnlyMode = inferredName === null;
  const [open, setOpen] = useState(false);
  // In edit-only mode the popover opens straight into the rename input.
  const [editing, setEditing] = useState(editOnlyMode);
  const [draft, setDraft] = useState(inferredName ?? currentName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `disabled={busy}` only takes effect on the next render, so a fast
  // double-click (or a re-click when nothing visibly happened) can fire two
  // requests before the button disables. This ref dedupes synchronously so a
  // duplicate confirm never leaves the browser.
  const busyRef = useRef(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const stop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };

  function call(body: { action: "confirm" | "rename" | "dismiss"; name?: string }) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // runAction swallows the rejection into `error` instead of letting it
    // bubble out as an unhandled promise rejection that Next.js's dev overlay
    // counts (the spurious "no inferred name to confirm" the operator saw on a
    // confirm that had actually succeeded). `.finally` always clears busy; its
    // rejection is handled by runAction's own `.catch`, so nothing leaks.
    runAction(
      apiPost(`/runner/control/person/${personId}/rename`, body).finally(() => {
        busyRef.current = false;
        setBusy(false);
      }),
      setError,
      () => {
        setOpen(false);
        setEditing(false);
        onChanged();
      }
    );
  }

  return (
    <span ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={(event) => {
          stop(event);
          setError(null);
          setEditing(editOnlyMode);
          setDraft(inferredName ?? currentName ?? "");
          setOpen((prev) => !prev);
        }}
        className={
          editOnlyMode
            ? "rounded px-[5px] py-[1px] text-[10px] text-ink-3 opacity-0 hover:bg-paper-2 hover:text-ink-2 group-hover:opacity-100 transition-opacity duration-calm"
            : "rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium tracking-[0.02em] text-ink-2 hover:bg-ink hover:text-paper transition-colors duration-calm"
        }
        title={editOnlyMode ? "Edit name" : "Click to confirm or change this guessed name"}
      >
        {editOnlyMode ? "✎" : `Maybe ${inferredName}`}
      </button>
      {open ? (
        <span
          onClick={stop}
          onMouseDown={stop}
          className="absolute left-0 top-[calc(100%+4px)] z-20 flex min-w-[200px] flex-col gap-1 rounded-card border border-hairline bg-paper p-1 shadow-lg"
        >
          {editing ? (
            <span className="flex items-center gap-1 p-1">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={stop}
                disabled={busy}
                className="flex-1 rounded border border-hairline bg-paper-2 px-2 py-1 text-[12px] text-ink focus:border-ink-3 focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  if (draft.trim()) void call({ action: "rename", name: draft.trim() });
                }}
                disabled={busy || !draft.trim()}
                className="rounded bg-ink px-2 py-1 text-[11px] font-medium text-paper disabled:opacity-50"
              >
                Save
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  void call({ action: "confirm" });
                }}
                disabled={busy}
                className="rounded px-2 py-1 text-left text-[12px] text-ink hover:bg-paper-2"
              >
                Use {inferredName}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  setEditing(true);
                }}
                disabled={busy}
                className="rounded px-2 py-1 text-left text-[12px] text-ink hover:bg-paper-2"
              >
                Edit name…
              </button>
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  void call({ action: "dismiss" });
                }}
                disabled={busy}
                className="rounded px-2 py-1 text-left text-[12px] text-ink-2 hover:bg-paper-2"
              >
                Not this one
              </button>
            </>
          )}
          {error ? (
            <span className="px-2 py-1 text-[11px] text-ink-2">{error}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
