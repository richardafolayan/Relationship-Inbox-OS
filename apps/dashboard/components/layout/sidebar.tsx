"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sun, Inbox, AlertTriangle, Archive, Users, Cable, ListChecks, Settings as SettingsIcon } from "lucide-react";
import type { HealthResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SidebarProps {
  health: HealthResponse | null;
  attentionCount: number;
  userInitials: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Sun;
  attention?: boolean;
}

const nav: NavItem[] = [
  { href: "/today", label: "Today", icon: Sun, attention: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/at-risk", label: "At Risk", icon: AlertTriangle },
  { href: "/archived", label: "Archived", icon: Archive },
  { href: "/people", label: "People", icon: Users },
  { href: "/platforms", label: "Platforms", icon: Cable },
  { href: "/logs", label: "Activity", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: SettingsIcon }
];

export function Sidebar({ health, attentionCount, userInitials }: SidebarProps) {
  const pathname = usePathname();
  const healthy = health?.runnerStatus === "ONLINE";

  return (
    <aside className="sticky top-0 z-10 flex h-screen w-[200px] flex-col border-r border-hairline bg-paper py-5 px-3">
      <Link
        href="/today"
        className="mx-2 mb-6 flex items-center gap-2 text-ink"
        aria-label="Relationship Inbox OS"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-ink font-display text-[14px] font-bold text-paper tracking-[-0.04em]">
          R
        </span>
        <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">Inbox OS</span>
      </Link>

      <nav className="flex flex-col gap-[2px]">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const showDot = item.attention && attentionCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-3 rounded-[10px] px-3 py-2 text-[13px] tracking-[-0.005em]",
                "transition-[color,background-color] duration-calm",
                active
                  ? "bg-ink text-paper font-medium"
                  : "text-ink-2 hover:bg-paper-2 hover:text-ink"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-[16px] w-[16px] shrink-0" strokeWidth={active ? 2 : 1.6} />
              <span className="flex-1 truncate">{item.label}</span>
              {showDot ? (
                <span
                  className={cn(
                    "ml-auto inline-flex min-w-[18px] justify-center rounded-full px-[6px] py-[1px] font-mono text-[10px] font-medium",
                    active ? "bg-paper text-ink" : "bg-accent/15 text-accent"
                  )}
                  aria-label={`${attentionCount} need attention`}
                >
                  {attentionCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-3 rounded-[10px] border border-hairline bg-paper-2/40 px-3 py-2">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[12px] font-semibold text-white"
          aria-label="Operator avatar"
        >
          {userInitials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[12px] font-medium text-ink">Operator</p>
          <p className="m-0 flex items-center gap-[6px] text-[11px] text-ink-3">
            <span
              className={cn(
                "h-[6px] w-[6px] rounded-full",
                healthy ? "bg-risk-fresh" : "bg-risk-overdue"
              )}
              aria-hidden
            />
            <span>{healthy ? "Runner online" : "Runner offline"}</span>
          </p>
        </div>
      </div>
    </aside>
  );
}
