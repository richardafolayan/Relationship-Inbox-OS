"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type ActionItemChecklistState,
  CATEGORY_LABEL,
  categorizeActionItem,
  emptyChecklistState,
  hashActionItem,
  loadChecklistState,
  newManualItemId,
  resolveItemText,
  saveChecklistState
} from "@/lib/action-items";

interface ActionItemsChecklistProps {
  threadId: string;
  /** Active open loops from the server (Thread.openLoopsJson). */
  openLoops: string[];
  /** Dismissed loops from the server (Thread.dismissedOpenLoopsJson). */
  dismissedOpenLoops: string[];
  /** Reopen mode reframes the heading: warm callbacks rather than pending asks. */
  isReopenMode: boolean;
  /** Dismiss / restore a loop. Wired to the existing /open-loop endpoint. */
  onDismiss: (loop: string, dismissed: boolean) => void;
}

// A reply checklist — a thinking aid for writing a real reply, not a task
// list. Ticking an item never changes the message; it just helps the user
// keep track of what they've covered. Tick / edit / manual-item state lives
// in localStorage; "not relevant" reuses the server-side dismiss.
export function ActionItemsChecklist({
  threadId,
  openLoops,
  dismissedOpenLoops,
  isReopenMode,
  onDismiss
}: ActionItemsChecklistProps) {
  const [state, setState] = useState<ActionItemChecklistState>(emptyChecklistState);
  const [hydrated, setHydrated] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // Load checklist state once per thread.
  useEffect(() => {
    setState(loadChecklistState(threadId));
    setHydrated(true);
    setEditingKey(null);
    setDraft("");
  }, [threadId]);

  // Persist on change, but only after the initial load so hydration doesn't
  // immediately rewrite storage.
  useEffect(() => {
    if (!hydrated) return;
    saveChecklistState(threadId, state);
  }, [threadId, state, hydrated]);

  useEffect(() => {
    if (editingKey) editInputRef.current?.focus();
  }, [editingKey]);

  const heading = isReopenMode ? "Conversation hooks" : "Things to address";
  const helper = isReopenMode
    ? "Worth picking up on when you reconnect. Tick each off as you write."
    : "Tick each off as you write your reply. This is just a checklist — it never changes your message.";

  const toggleChecked = (key: string) => {
    setState((prev) => ({ ...prev, checked: { ...prev.checked, [key]: !prev.checked[key] } }));
  };

  const startEdit = (key: string, currentText: string) => {
    setEditingKey(key);
    setEditValue(currentText);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue("");
  };

  const commitLoopEdit = (loop: string) => {
    const key = hashActionItem(loop);
    const next = editValue.trim();
    setState((prev) => {
      const editedText = { ...prev.editedText };
      if (!next || next === loop.trim()) delete editedText[key];
      else editedText[key] = next;
      return { ...prev, editedText };
    });
    cancelEdit();
  };

  const commitManualEdit = (id: string) => {
    const next = editValue.trim();
    setState((prev) => {
      if (!next) return { ...prev, manualItems: prev.manualItems.filter((m) => m.id !== id) };
      return {
        ...prev,
        manualItems: prev.manualItems.map((m) => (m.id === id ? { ...m, text: next } : m))
      };
    });
    cancelEdit();
  };

  const toggleManual = (id: string) => {
    setState((prev) => ({
      ...prev,
      manualItems: prev.manualItems.map((m) => (m.id === id ? { ...m, checked: !m.checked } : m))
    }));
  };

  const removeManual = (id: string) => {
    setState((prev) => ({ ...prev, manualItems: prev.manualItems.filter((m) => m.id !== id) }));
  };

  const addManual = () => {
    const text = draft.trim();
    if (!text) return;
    setState((prev) => ({
      ...prev,
      manualItems: [...prev.manualItems, { id: newManualItemId(), text, checked: false }]
    }));
    setDraft("");
  };

  // De-dupe: a loop the operator dismissed should not also show as active
  // even if the server list lags a beat behind an optimistic update.
  const dismissedSet = useMemo(() => new Set(dismissedOpenLoops), [dismissedOpenLoops]);
  const activeLoops = useMemo(
    () => openLoops.filter((loop) => !dismissedSet.has(loop)),
    [openLoops, dismissedSet]
  );

  const isEmpty =
    activeLoops.length === 0 && state.manualItems.length === 0 && dismissedOpenLoops.length === 0;

  return (
    <section data-testid="action-items">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">{heading}</p>
      <p className="mb-3 text-[12px] leading-[1.5] text-ink-3">{helper}</p>

      {isEmpty ? (
        <p className="mb-3 text-[13px] leading-[1.5] text-ink-3">
          Nothing flagged on this thread. Add anything you want to cover before you send.
        </p>
      ) : null}

      <ul className="m-0 list-none space-y-[7px] p-0">
        {activeLoops.map((loop) => {
          const key = hashActionItem(loop);
          const display = resolveItemText(state, loop);
          const checked = Boolean(state.checked[key]);
          const category = categorizeActionItem(display);
          const editing = editingKey === key;
          return (
            <li key={`open:${loop}`} className="group flex items-start gap-2">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleChecked(key)}
                className="mt-[3px] h-[13px] w-[13px] shrink-0 cursor-pointer accent-ink"
                aria-label={`Mark "${display}" as addressed`}
              />
              <div className="min-w-0 flex-1">
                {editing ? (
                  <EditField
                    inputRef={editInputRef}
                    value={editValue}
                    onChange={setEditValue}
                    onCommit={() => commitLoopEdit(loop)}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <div className="flex items-baseline gap-[6px]">
                    <span
                      className={cn(
                        "rounded-[4px] border border-hairline px-[5px] py-[1px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3",
                        checked && "opacity-50"
                      )}
                    >
                      {CATEGORY_LABEL[category]}
                    </span>
                    <span
                      className={cn(
                        "text-[13px] leading-[1.5]",
                        checked ? "text-ink-4 line-through" : "text-ink-2"
                      )}
                    >
                      {display}
                    </span>
                  </div>
                )}
              </div>
              {editing ? null : (
                <div className="flex shrink-0 items-center gap-[6px] opacity-0 transition-opacity duration-calm group-hover:opacity-100 group-focus-within:opacity-100">
                  <RowAction label={`Edit "${display}"`} onClick={() => startEdit(key, display)}>
                    <Pencil className="h-[12px] w-[12px]" strokeWidth={1.7} />
                  </RowAction>
                  <RowAction label={`Set "${display}" aside as not relevant`} onClick={() => onDismiss(loop, true)}>
                    <X className="h-[13px] w-[13px]" strokeWidth={1.7} />
                  </RowAction>
                </div>
              )}
            </li>
          );
        })}

        {state.manualItems.map((item) => {
          const editing = editingKey === item.id;
          const category = categorizeActionItem(item.text);
          return (
            <li key={`manual:${item.id}`} className="group flex items-start gap-2">
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => toggleManual(item.id)}
                className="mt-[3px] h-[13px] w-[13px] shrink-0 cursor-pointer accent-ink"
                aria-label={`Mark "${item.text}" as addressed`}
              />
              <div className="min-w-0 flex-1">
                {editing ? (
                  <EditField
                    inputRef={editInputRef}
                    value={editValue}
                    onChange={setEditValue}
                    onCommit={() => commitManualEdit(item.id)}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <div className="flex items-baseline gap-[6px]">
                    <span
                      className={cn(
                        "rounded-[4px] border border-hairline px-[5px] py-[1px] font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3",
                        item.checked && "opacity-50"
                      )}
                    >
                      {CATEGORY_LABEL[category]}
                    </span>
                    <span
                      className={cn(
                        "text-[13px] leading-[1.5]",
                        item.checked ? "text-ink-4 line-through" : "text-ink-2"
                      )}
                    >
                      {item.text}
                    </span>
                  </div>
                )}
              </div>
              {editing ? null : (
                <div className="flex shrink-0 items-center gap-[6px] opacity-0 transition-opacity duration-calm group-hover:opacity-100 group-focus-within:opacity-100">
                  <RowAction label={`Edit "${item.text}"`} onClick={() => startEdit(item.id, item.text)}>
                    <Pencil className="h-[12px] w-[12px]" strokeWidth={1.7} />
                  </RowAction>
                  <RowAction label={`Remove "${item.text}"`} onClick={() => removeManual(item.id)}>
                    <X className="h-[13px] w-[13px]" strokeWidth={1.7} />
                  </RowAction>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form
        className="mt-[10px] flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addManual();
        }}
      >
        <Plus className="h-[13px] w-[13px] shrink-0 text-ink-3" strokeWidth={1.8} />
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add something to address…"
          className="flex-1 border-0 border-b border-transparent bg-transparent pb-[2px] text-[13px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
        />
        {draft.trim() ? (
          <button
            type="submit"
            className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
          >
            add
          </button>
        ) : null}
      </form>

      {dismissedOpenLoops.length > 0 ? (
        <div className="mt-4 border-t border-hairline pt-3">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.07em] text-ink-4">
            Set aside · {dismissedOpenLoops.length}
          </p>
          <ul className="m-0 list-none space-y-[5px] p-0">
            {dismissedOpenLoops.map((loop) => (
              <li key={`dismissed:${loop}`} className="group flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-ink-4 line-through">
                  {loop}
                </span>
                <RowAction
                  label={`Restore "${loop}"`}
                  onClick={() => onDismiss(loop, false)}
                  className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <RotateCcw className="h-[12px] w-[12px]" strokeWidth={1.7} />
                </RowAction>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function EditField({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="w-full rounded-row border border-hairline-strong bg-paper px-2 py-[4px] text-[13px] leading-[1.4] text-ink outline-none"
      aria-label="Edit item"
    />
  );
}

function RowAction({
  label,
  onClick,
  className,
  children
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-[20px] w-[20px] place-items-center rounded-[5px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink",
        className
      )}
    >
      {children}
    </button>
  );
}
