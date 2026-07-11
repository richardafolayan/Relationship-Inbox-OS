"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  Inbox,
  Search,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  MessageSquareText,
  User
} from "lucide-react";
import type { HealthResponse } from "@/lib/types";
import { formatAttentionBadge } from "@/lib/attention-badge";
import { cn } from "@/lib/utils";
import { openPilotFeedback } from "@/lib/pilot";
import { ThemeToggle } from "@/components/layout/theme-toggle";

interface SidebarProps {
  // `undefined` = the first /health fetch is still in flight (cold mount);
  // rendered as a calm "Connecting…" rather than "Runner offline" (#435).
  // `null` = a fetch completed and failed → genuine offline.
  health: HealthResponse | null | undefined;
  attentionCount: number;
  onOpenSearch: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /**
   * Operator's preferred display name, sourced from the operator_profile_v1
   * setting. `undefined` = still loading (footer shows a skeleton); `null`
   * / empty → falls back to the literal "Operator" so the footer never
   * collapses on a fresh install.
   */
  operatorDisplayName?: string | null;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Sun;
  attention?: boolean;
}

// v1 nav scope: only the inbox loop. /at-risk, /people, /platforms, /logs
// still resolve if typed directly; PR2 will decide which routes get deleted.
// Reconnect is the live nudge toward dormant ties. Archived is off the rail
// (pilot feedback #303) — reachable from a quiet link at the foot of the
// Inbox and via the ⌘K palette.
const nav: NavItem[] = [
  { href: "/today", label: "Today", icon: Sun, attention: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/reconnect", label: "Reconnect", icon: Sparkles },
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
  onToggleCollapsed,
  operatorDisplayName
}: SidebarProps) {
  const profileLoading = operatorDisplayName === undefined;
  const operatorLabel = operatorDisplayName?.trim() || "Operator";
  const pathname = usePathname();
  // Four runner states the sidebar can surface, in priority order:
  //   - unknown:     first /health fetch hasn't resolved yet (cold mount /
  //                  reload) → grey dot, "Connecting…". Distinct from
  //                  offline so a slow runner doesn't read as a dead one
  //                  while the dashboard is still asking (#435 / R-0057).
  //   - unreachable: a fetch completed and failed (network or the runner
  //                  process is genuinely down) → red dot, "Runner offline".
  //   - busy:        runner reachable but mid-task (scanning, sending, or
  //                  draining the enrichment queue) → amber dot, "Runner busy".
  //   - online:      reachable + idle → green dot, "Runner online".
  // The previous binary check (runnerStatus === "ONLINE") collapsed busy
  // into "Runner offline", which read as broken when the runner was
  // actually working as intended.
  const runnerLabel: { kind: "online" | "busy" | "offline" | "unknown"; text: string } = (() => {
    if (health === undefined) return { kind: "unknown", text: "Connecting…" };
    if (!health) return { kind: "offline", text: "App helper paused" };
    if (health.runnerStatus !== "ONLINE") return { kind: "busy", text: "App working" };
    if ((health.enrichmentQueue?.total ?? 0) > 0) return { kind: "busy", text: "App working" };
    return { kind: "online", text: "App ready" };
  })();
  const dotColor =
    runnerLabel.kind === "online"
      ? "bg-risk-fresh"
      : runnerLabel.kind === "busy"
        ? "bg-risk-waiting"
        : runnerLabel.kind === "unknown"
          ? "bg-ink-3"
          : "bg-ink-3";

  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleTitle = collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)";

  return (
    <aside
      className={cn(
        // Hidden below md: phone navigation moves to the bottom MobileDock.
        "sticky top-0 z-10 hidden h-app-screen flex-col border-r border-hairline bg-paper py-5 md:flex",
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
          // Pilot R-0089 (#756): the marker is a count again — how many
          // threads still need a reply in today's queue, capped at 99+.
          // Same number as Today's "N need you tonight", so the sidebar
          // and the page never disagree. Stays a small warm pill, not a
          // red alarm badge (PRODUCT.md).
          const badge = item.attention ? formatAttentionBadge(attentionCount) : "";
          return (
            <Link
              key={item.href}
              href={item.href}
              data-demo-target={`nav-${item.href.replace(/^\//, "")}`}
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
                  {badge ? (
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded-full px-[6px] py-[1px] font-mono text-[10px] leading-[14px] tracking-[0.02em]",
                        active ? "bg-paper/20 text-paper" : "bg-accent text-white"
                      )}
                      aria-label={`${attentionCount} ${attentionCount === 1 ? "thread" : "threads"} waiting in today's queue`}
                    >
                      {badge}
                    </span>
                  ) : null}
                </>
              ) : badge ? (
                <span
                  className="absolute -right-[3px] -top-[3px] rounded-full bg-accent px-[4px] py-[1px] font-mono text-[9px] leading-[12px] text-white"
                  aria-label={`${attentionCount} ${attentionCount === 1 ? "thread" : "threads"} waiting in today's queue`}
                >
                  {badge}
                </span>
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
        data-demo-target="feedback"
        data-tour="feedback"
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
          collapsed ? "justify-center" : "gap-2 px-3"
        )}
        title={collapsed ? `${operatorLabel} · ${runnerLabel.text}` : undefined}
      >
        <div
          className={cn(
            "relative grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#9a2727] to-[#6b1818] text-white",
            collapsed ? "h-7 w-7" : "h-8 w-8"
          )}
          aria-label="Operator avatar"
        >
          <User
            className={collapsed ? "h-[13px] w-[13px]" : "h-[15px] w-[15px]"}
            strokeWidth={1.8}
          />
          <span
            className={cn(
              "absolute -bottom-[1px] -right-[1px] h-[8px] w-[8px] rounded-full border border-paper",
              dotColor
            )}
            aria-hidden
          />
        </div>
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1">
              {profileLoading ? (
                <span className="block h-[12px] w-20 rounded bg-paper-2" aria-hidden />
              ) : (
                <p className="m-0 truncate text-[12px] font-medium text-ink">{operatorLabel}</p>
              )}
              <p className="m-0 truncate whitespace-nowrap text-[11px] text-ink-3">
                {runnerLabel.text}
              </p>
            </div>
            <ThemeToggle />
          </>
        ) : null}
      </div>
    </aside>
  );
}
