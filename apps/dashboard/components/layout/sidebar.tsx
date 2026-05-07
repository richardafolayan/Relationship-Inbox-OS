"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Zap, Inbox, Users, Cable, ListChecks, Search, Settings as SettingsIcon } from "lucide-react";
import type { HealthResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SidebarProps {
  health: HealthResponse | null;
  attentionCount: number;
  userInitials: string;
  onOpenSearch: () => void;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Zap;
  attention?: boolean;
}

const nav: NavItem[] = [
  { href: "/today", label: "Today", icon: Zap, attention: true },
  { href: "/inbox", label: "All inbox", icon: Inbox },
  { href: "/people", label: "People", icon: Users },
  { href: "/platforms", label: "Platforms", icon: Cable },
  { href: "/logs", label: "Activity", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: SettingsIcon }
];

// 72px icon rail. Tooltips on hover, attention dot on Today when there
// are overdue/waiting threads, and a tiny health dot + user avatar in the
// footer. Search is a discoverable rail icon that opens the ⌘K palette
// (the redesign removed the topbar; this gives operators a visible
// affordance instead of a hidden keyboard-only shortcut).
export function Sidebar({ health, attentionCount, userInitials, onOpenSearch }: SidebarProps) {
  const pathname = usePathname();
  const healthy = health?.runnerStatus === "ONLINE";

  return (
    <aside className="sticky top-0 z-10 flex h-screen w-[72px] flex-col items-center border-r border-hairline bg-paper py-[18px] px-[10px]">
      <Link
        href="/today"
        className="mb-[22px] grid h-8 w-8 place-items-center rounded-[10px] bg-ink font-display text-[14px] font-bold text-paper tracking-[-0.04em]"
        aria-label="Relationship Inbox"
      >
        R
      </Link>

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search (⌘K)"
        className="group relative mb-2 grid h-11 w-11 place-items-center rounded-[12px] text-ink-3 transition-[color,background-color] duration-calm hover:bg-paper-2 hover:text-ink"
      >
        <Search className="h-[18px] w-[18px]" strokeWidth={1.6} />
        <span
          className="pointer-events-none absolute left-[calc(100%+12px)] top-1/2 -translate-y-1/2 flex items-center gap-[6px] whitespace-nowrap rounded-lg bg-ink px-[10px] py-[6px] text-[12px] tracking-[-0.01em] text-paper opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          role="tooltip"
        >
          Search
          <span className="font-mono text-[10px] text-paper/70">⌘K</span>
        </span>
      </button>

      <nav className="flex w-full flex-col items-center gap-[2px]">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const showDot = item.attention && attentionCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                "group relative grid h-11 w-11 place-items-center rounded-[12px]",
                "transition-[color,background-color] duration-calm",
                active ? "bg-paper-2 text-ink" : "text-ink-3 hover:bg-paper-2 hover:text-ink"
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.6} />
              {showDot ? (
                <span className="absolute right-2 top-2 h-[6px] w-[6px] rounded-full bg-accent" aria-hidden />
              ) : null}
              <span
                className="pointer-events-none absolute left-[calc(100%+12px)] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-ink px-[10px] py-[6px] text-[12px] tracking-[-0.01em] text-paper opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                role="tooltip"
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-3">
        <span
          aria-label={healthy ? "All systems quiet" : "Runner not online"}
          title={healthy ? "All systems quiet" : "Runner not online"}
          className={cn(
            "h-2 w-2 rounded-full",
            healthy ? "bg-risk-fresh shadow-[0_0_0_4px_color-mix(in_oklch,var(--risk-fresh)_14%,transparent)]" : "bg-risk-overdue"
          )}
        />
        <div
          className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[13px] font-semibold text-white"
          aria-label="Operator avatar"
        >
          {userInitials}
        </div>
      </div>
    </aside>
  );
}
