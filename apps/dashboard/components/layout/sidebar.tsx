"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  Inbox,
  Archive,
  Search,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquareText,
  User
} from "lucide-react";
import type { HealthResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { openPilotFeedback } from "@/lib/pilot";
import { ThemeToggle } from "@/components/layout/theme-toggle";

interface SidebarProps {
  health: HealthResponse | null;
  attentionCount: number;
  onOpenSearch: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Sun;
  attention?: boolean;
}

// v1 nav scope: only the inbox loop. /at-risk, /people, /platforms, /logs
// still resolve if typed directly; PR2 will decide which routes get deleted.
const nav: NavItem[] = [
  { href: "/today", label: "Today", icon: Sun, attention: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/archived", label: "Archived", icon: Archive },
  { href: "/settings", label: "Settings", icon: SettingsIcon }
];

// 200px labelled sidebar (per #47). Collapses to a 56px icon rail when
// `collapsed` is true so operators with narrow screens can reclaim the
// horizontal space. Search is a discoverable button at the top that opens
// the ⌘K palette - gives operators a visible affordance for what was a
// keyboard-only shortcut after the redesign.
export function Sidebar({
  health,
  attentionCount,
  onOpenSearch,
  collapsed,
  onToggleCollapsed
}: SidebarProps) {
  const pathname = usePathname();
  // Three runner states the sidebar can surface, in priority order:
  //   - unreachable: dashboard couldn't fetch /runner/health (network or
  //     the runner process is genuinely down) → red dot, "Runner offline".
  //   - busy:       runner reachable but mid-task (scanning, sending, or
  //                 draining the enrichment queue) → amber dot, "Runner busy".
  //   - online:     reachable + idle → green dot, "Runner online".
  // The previous binary check (runnerStatus === "ONLINE") collapsed busy
  // into "Runner offline", which read as broken when the runner was
  // actually working as intended.
  const runnerLabel: { kind: "online" | "busy" | "offline"; text: string } = (() => {
    if (!health) return { kind: "offline", text: "Runner offline" };
    if (health.runnerStatus !== "ONLINE") return { kind: "busy", text: "Runner busy" };
    if ((health.enrichmentQueue?.total ?? 0) > 0) return { kind: "busy", text: "Runner busy" };
    return { kind: "online", text: "Runner online" };
  })();
  const dotColor =
    runnerLabel.kind === "online"
      ? "bg-risk-fresh"
      : runnerLabel.kind === "busy"
        ? "bg-risk-waiting"
        : "bg-risk-overdue";

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleTitle = collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)";

  return (
    <aside
      className={cn(
        "sticky top-0 z-10 flex h-screen flex-col border-r border-hairline bg-paper py-5",
        collapsed ? "w-[56px] px-2" : "w-[200px] px-3"
      )}
    >
      <div className={cn("mb-6 flex items-center", collapsed ? "justify-center" : "mx-2 justify-between")}>
        <Link
          href="/today"
          className="flex items-center gap-2 text-ink"
          aria-label="Relationship Inbox OS"
          title={collapsed ? "Relationship Inbox OS" : undefined}
        >
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-ink font-display text-[14px] font-bold text-paper tracking-[-0.04em]">
            R
          </span>
          {!collapsed ? (
            <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">Inbox OS</span>
          ) : null}
        </Link>
        {!collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={toggleTitle}
            title={toggleTitle}
            className="grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <ToggleIcon className="h-[16px] w-[16px]" strokeWidth={1.6} />
          </button>
        ) : null}
      </div>

      {collapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={toggleTitle}
          title={toggleTitle}
          className="mb-2 grid h-9 w-9 place-items-center self-center rounded-[10px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
        >
          <ToggleIcon className="h-[18px] w-[18px]" strokeWidth={1.6} />
        </button>
      ) : null}

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search (⌘K)"
        title={collapsed ? "Search (⌘K)" : undefined}
        className={cn(
          "mb-2 flex items-center rounded-[10px] text-[13px] tracking-[-0.005em] text-ink-2 transition-[color,background-color] duration-calm hover:bg-paper-2 hover:text-ink",
          collapsed ? "h-9 w-9 justify-center self-center" : "mx-2 gap-3 px-3 py-2"
        )}
      >
        <Search className="h-[18px] w-[18px]" strokeWidth={1.6} />
        {!collapsed ? (
          <>
            <span className="flex-1 text-left">Search</span>
            <span className="font-mono text-[10px] text-ink-3">⌘K</span>
          </>
        ) : null}
      </button>

      <nav className="flex flex-col gap-[2px]">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const showDot = item.attention && attentionCount > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "relative flex items-center rounded-[10px] text-[13px] tracking-[-0.005em]",
                "transition-[color,background-color] duration-calm",
                collapsed ? "h-9 w-9 justify-center self-center" : "gap-3 px-3 py-2",
                active
                  ? "bg-ink text-paper font-medium"
                  : "text-ink-2 hover:bg-paper-2 hover:text-ink"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon
                className={cn("shrink-0", collapsed ? "h-[18px] w-[18px]" : "h-[16px] w-[16px]")}
                strokeWidth={active ? 2 : 1.6}
              />
              {!collapsed ? (
                <>
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
                </>
              ) : showDot ? (
                <span
                  className="absolute right-[2px] top-[2px] h-[6px] w-[6px] rounded-full bg-accent"
                  aria-label={`${attentionCount} need attention`}
                />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={() => openPilotFeedback("feedback")}
        aria-label="Send feedback"
        title={collapsed ? "Send feedback" : undefined}
        className={cn(
          "mt-auto flex items-center rounded-[10px] text-[13px] tracking-[-0.005em] text-ink-2",
          "transition-[color,background-color] duration-calm hover:bg-paper-2 hover:text-ink",
          collapsed ? "h-9 w-9 justify-center self-center" : "gap-3 px-3 py-2"
        )}
      >
        <MessageSquareText
          className={cn("shrink-0", collapsed ? "h-[18px] w-[18px]" : "h-[16px] w-[16px]")}
          strokeWidth={1.6}
        />
        {!collapsed ? <span className="flex-1 text-left">Feedback</span> : null}
      </button>

      <div
        className={cn(
          "mt-3 flex items-center border-t border-hairline pt-3",
          collapsed ? "justify-center" : "gap-3 px-3"
        )}
        title={collapsed ? `Operator · ${runnerLabel.text}` : undefined}
      >
        <div
          className={cn(
            "relative grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] text-white",
            collapsed ? "h-7 w-7" : "h-8 w-8"
          )}
          aria-label="Operator avatar"
        >
          <User
            className={collapsed ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"}
            strokeWidth={1.8}
          />
          {collapsed ? (
            <span
              className={cn(
                "absolute -bottom-[1px] -right-[1px] h-[8px] w-[8px] rounded-full border border-paper",
                dotColor
              )}
              aria-hidden
            />
          ) : null}
        </div>
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-[12px] font-medium text-ink">Operator</p>
              <p className="m-0 flex items-center gap-[6px] text-[11px] text-ink-3">
                <span
                  className={cn("h-[6px] w-[6px] rounded-full", dotColor)}
                  aria-hidden
                />
                <span>{runnerLabel.text}</span>
              </p>
            </div>
            <ThemeToggle />
          </>
        ) : null}
      </div>
    </aside>
  );
}
