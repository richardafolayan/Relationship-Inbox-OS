"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, Bell, CircleAlert, Users, Cable, ListChecks, Settings, RefreshCw, Sparkles } from "lucide-react";
import type { HealthResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SidebarProps {
  health: HealthResponse | null;
  lastScanAt: string | null;
  onScanNow: () => Promise<void>;
}

const nav = [
  { href: "/inbox", label: "Inbox", icon: Bell },
  { href: "/at-risk", label: "At Risk", icon: CircleAlert },
  { href: "/archived", label: "Archived", icon: Archive },
  { href: "/people", label: "People", icon: Users },
  { href: "/platforms", label: "Platforms", icon: Cable },
  { href: "/logs", label: "Activity Log", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function Sidebar({ health, lastScanAt, onScanNow }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 flex h-screen w-[260px] flex-col border-r border-slate-200 bg-white px-4 py-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Relationship Inbox OS</p>
        <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Sparkles className="h-4 w-4 text-blue-600" />
          Inbox OS
        </h1>
      </div>

      <nav className="mt-6 space-y-1">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition duration-calm",
                active ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-100"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <Button className="w-full" variant="primary" onClick={() => void onScanNow()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Scan now
        </Button>

        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>Runner</span>
          <Badge tone={health?.runnerStatus === "SCANNING" ? "amber" : health?.runnerStatus === "ERROR" ? "red" : "green"}>
            {health?.runnerStatus ?? "-"}
          </Badge>
        </div>

        <p className="text-xs text-slate-500">Last scan: {formatRelative(lastScanAt)}</p>
      </div>
    </aside>
  );
}
