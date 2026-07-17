"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sun, Inbox, Search, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { formatAttentionBadge } from "@/lib/attention-badge";
import { cn } from "@/lib/utils";

interface MobileDockProps {
  attentionCount: number;
  onOpenSearch: () => void;
}

const tabs = [
  { href: "/today", label: "Today", icon: Sun, attention: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/reconnect", label: "Reconnect", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: SettingsIcon }
] as const;

// Phone-width replacement for the sidebar: an in-flow bottom icon dock
// rendered as a shell layout row (the sidebar itself is hidden below
// md). Not position:fixed so list pages can fill the remaining height
// without guessing bottom padding. Hidden inside a thread so the
// conversation + composer get the full height. The dock is the sole
// owner of env(safe-area-inset-bottom) for primary navigation.
export function MobileDock({ attentionCount, onOpenSearch }: MobileDockProps) {
  const pathname = usePathname();
  if (pathname.startsWith("/thread/")) return null;

  return (
    <nav
      aria-label="Primary"
      data-testid="mobile-dock"
      className="relative z-30 flex shrink-0 items-stretch justify-around border-t border-hairline bg-[color-mix(in_oklch,var(--paper)_92%,transparent)] px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-md backdrop-saturate-150 md:hidden"
    >
      {tabs.slice(0, 2).map((tab) => (
        <DockTab
          key={tab.href}
          {...tab}
          active={pathname === tab.href || pathname.startsWith(`${tab.href}/`)}
          badge={"attention" in tab && tab.attention ? attentionCount : 0}
        />
      ))}
      <button
        type="button"
        onClick={onOpenSearch}
        className="flex flex-1 flex-col items-center gap-[3px] px-1 pb-[6px] pt-[8px] text-ink-3 transition-colors duration-calm hover:text-ink"
        aria-label="Search (⌘K)"
      >
        <Search className="h-[21px] w-[21px]" strokeWidth={1.6} />
        <span className="font-mono text-[10px] tracking-[0.04em]">Search</span>
      </button>
      {tabs.slice(2).map((tab) => (
        <DockTab
          key={tab.href}
          {...tab}
          active={pathname === tab.href || pathname.startsWith(`${tab.href}/`)}
          badge={0}
        />
      ))}
    </nav>
  );
}

function DockTab({
  href,
  label,
  icon: Icon,
  active,
  badge
}: {
  href: string;
  label: string;
  icon: typeof Sun;
  active: boolean;
  badge: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex flex-1 flex-col items-center gap-[3px] px-1 pb-[6px] pt-[8px] transition-colors duration-calm",
        active ? "text-ink" : "text-ink-3 hover:text-ink"
      )}
    >
      <span className="relative">
        <Icon className="h-[21px] w-[21px]" strokeWidth={active ? 2 : 1.6} />
        {badge > 0 ? (
          // Pilot R-0089 (#756): a small warm count (99+ cap), matching
          // the sidebar. Same attentionCount as Today's "N need you
          // tonight".
          <span
            className="absolute -right-[10px] -top-[4px] rounded-full bg-accent px-[4px] py-[1px] font-mono text-[9px] leading-[12px] text-white"
            aria-label={`${badge} ${badge === 1 ? "thread" : "threads"} waiting in today's queue`}
          >
            {formatAttentionBadge(badge)}
          </span>
        ) : null}
      </span>
      <span className="font-mono text-[10px] tracking-[0.04em]">{label}</span>
    </Link>
  );
}
