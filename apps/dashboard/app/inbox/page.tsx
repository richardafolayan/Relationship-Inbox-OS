"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive as ArchiveIcon, CheckCircle2, FolderOpen, Search as SearchIcon } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, PlatformCard } from "@/lib/types";
import { formatRelative, formatClock } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

function riskTone(level: string): "green" | "amber" | "red" {
  if (level === "RED") {
    return "red";
  }
  if (level === "AMBER") {
    return "amber";
  }
  return "green";
}

export default function InboxPage() {
  const router = useRouter();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unread" | "risk">("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | "genuine" | "outreach">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [receiptsOpen, setReceiptsOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [inbox, platformRows, logRows] = await Promise.all([
        apiGet<InboxResponse>("/runner/data/inbox"),
        apiGet<PlatformCard[]>("/runner/data/platforms"),
        apiGet<AuditLogRow[]>("/runner/data/logs?limit=100")
      ]);

      setData(inbox);
      setPlatforms(platformRows);
      setLogs(logRows);
      setError(null);
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : "Failed to load inbox data";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onResync = () => {
      void refresh();
    };

    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  const degradedPlatform = useMemo(
    () => platforms.find((platform) => platform.status === "DEGRADED"),
    [platforms]
  );

  const filteredRows = useMemo(() => {
    if (!data) {
      return [];
    }
    let rows = data.rows;
    if (filter === "unread") {
      rows = rows.filter((row) => row.unreadCount > 0);
    } else if (filter === "risk") {
      rows = rows.filter((row) => row.riskLevel !== "GREEN");
    }
    if (categoryFilter !== "all") {
      rows = rows.filter((row) => row.category === categoryFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      rows = rows.filter((row) => `${row.personName} ${row.preview}`.toLowerCase().includes(q));
    }
    return rows;
  }, [data, filter, categoryFilter, searchQuery]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-slate-900">Runner unavailable</p>
          <p className="mt-1 text-sm text-slate-500">
            Could not reach the runner on <code>localhost:4001</code>. {error ?? "Try again in a moment."}
          </p>
          <div className="mt-3">
            <Button onClick={() => void refresh()}>Retry</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-4 overflow-hidden">
      {error ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <p className="text-sm font-semibold text-amber-900">Runner connection issue</p>
          <p className="mt-1 text-sm text-amber-800">{error}</p>
        </Card>
      ) : null}

      {degradedPlatform ? (
        <DegradedBanner
          platform={degradedPlatform.platform}
          domDumpFile={logs.find((log) => log.platform === degradedPlatform.platform && log.domDumpFile)?.domDumpFile}
          onRunSelectorTests={() => {
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: degradedPlatform.platform }),
              setError,
              refresh
            );
          }}
          onOpenReceipts={() => setReceiptsOpen(true)}
        />
      ) : null}

      <div>
        <h2 className="text-2xl font-semibold">Inbox</h2>
        <p className="text-sm text-slate-500">Keep conversations moving without re-reading everything.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="cursor-pointer" onClick={() => setFilter("unread")}>
          <p className="text-xs text-slate-500">Unread</p>
          <p className="mt-2 text-2xl font-semibold">{data.summary.unreadThreads}</p>
        </Card>
        <Card className="cursor-pointer" onClick={() => setFilter("risk")}>
          <p className="text-xs text-slate-500">At risk</p>
          <p className="mt-2 text-2xl font-semibold">{data.summary.atRiskThreads}</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500">Oldest pending inbound</p>
          <p className="mt-2 text-lg font-semibold">{formatRelative(data.summary.oldestPendingInboundAt)}</p>
        </Card>
      </div>

      {/* Inbox-local search + category filter row. Sits above the table so
          it's visually a thread-list refinement, distinct from the global
          search in the topbar (which navigates anywhere across the app).
          Both can be active at once. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter visible threads…"
            className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value as "all" | "genuine" | "outreach")}
          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
        >
          <option value="all">All threads</option>
          <option value="genuine">Genuine only</option>
          <option value="outreach">Outreach only</option>
        </select>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-3 border-b border-slate-200 px-4 py-3 text-xs font-medium uppercase tracking-wide text-slate-500">
          <span>Person</span>
          <span>Platform</span>
          <span>Preview</span>
          <span>Time</span>
          <span>Status</span>
          <span className="text-right">Actions</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredRows.map((row) => {
          // Spec'd in Phase 2:
          //   - emerald dot when the operator was the last sender (replied)
          //   - rose dot when the other party is awaiting a reply
          //   - slate when neither (e.g. archived thread previewed elsewhere)
          const indicatorColor =
            row.lastMessageDirection === "OUT"
              ? "bg-emerald-500"
              : row.needsReply
                ? "bg-rose-500"
                : "bg-slate-300";
          // Show the latest message regardless of sender. When the operator
          // replied last, prefix with "You: " (LinkedIn convention).
          const previewBody =
            row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
          return (
            <div
              key={row.id}
              className="group grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] gap-3 border-b border-slate-100 px-4 py-3 transition duration-calm hover:bg-slate-50"
            >
              <div className="flex min-w-0 items-start gap-2">
                {/* Replied / needs-reply indicator. Same shape as LinkedIn's
                    own inbox uses an unread dot, except here it carries
                    direction info too. */}
                <span
                  className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${indicatorColor}`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{row.personName}</p>
                  <p className="text-xs text-slate-500">Inbound • {formatRelative(row.lastInboundAt)}</p>
                  {row.identityWarning === "unresolved_id" ? (
                    <p className="text-[11px] text-amber-700">Identity warning: unresolved thread ID</p>
                  ) : null}
                  {row.category === "outreach" ? (
                    <Badge tone="amber">Outreach</Badge>
                  ) : null}
                </div>
              </div>
              <div>
                <Badge tone="blue">{row.platform}</Badge>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-700">{previewBody}</p>
              </div>
              <div>
                <p className="text-sm text-slate-700">{formatClock(row.lastMessageAt)}</p>
                <p className="text-xs text-slate-500">{formatRelative(row.lastMessageAt)}</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge tone={riskTone(row.riskLevel)}>{row.riskLevel}</Badge>
                  {row.unreadCount > 0 ? <Badge>{row.unreadCount} unread</Badge> : null}
                  {row.identityWarning === "unresolved_id" ? <Badge tone="amber">Unresolved ID</Badge> : null}
                </div>
                <p className="text-xs text-slate-500">{row.slaCountdown}</p>
                {row.needsReply ? <Badge tone="amber">Needs reply</Badge> : null}
              </div>
              <div className="flex items-center justify-end gap-1 opacity-0 transition duration-calm group-hover:opacity-100">
                <Button variant="ghost" onClick={() => router.push(`/thread/${row.id}`)} title="Open thread">
                  <FolderOpen className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  title="Archive"
                  onClick={() =>
                    runAction(apiPost(`/runner/control/thread/${row.id}/archive`, {}), setError, refresh)
                  }
                >
                  <ArchiveIcon className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  title="Mark done"
                  onClick={() =>
                    runAction(apiPost(`/runner/control/thread/${row.id}/mark-done`, {}), setError, refresh)
                  }
                >
                  <CheckCircle2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}

        {!filteredRows.length ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">Inbox is clear. No relationship leaks right now.</div>
        ) : null}
        </div>
      </div>

      <ReceiptsDrawer open={receiptsOpen} onClose={() => setReceiptsOpen(false)} rows={logs} title="Receipts" />
    </div>
  );
}
