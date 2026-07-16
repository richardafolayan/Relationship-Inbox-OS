"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}

// Lightweight, dependency-free dropdown menu used for the Platforms page
// overflow actions. Closes on outside-click, Escape, and after any item
// selects. Right-aligned by default to match its usage on a row's trailing
// edge.
export function Menu({ trigger, items, align = "end" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <span onClick={() => setOpen((prev) => !prev)}>{trigger}</span>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-[calc(100%+6px)] z-30 min-w-[184px] overflow-hidden rounded-[10px] border border-hairline bg-paper py-1 shadow-card",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center px-3 py-[7px] text-left text-[13px] transition-colors duration-calm hover:bg-paper-2",
                item.danger ? "text-accent-ink hover:bg-accent-soft" : "text-ink-2 hover:text-ink"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
