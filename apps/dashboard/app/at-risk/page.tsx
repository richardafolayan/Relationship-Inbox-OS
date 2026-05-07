"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AtRiskPage() {
  const router = useRouter();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusOpen, setFocusOpen] = useState(false);

  // Failure must surface inline rather than leaving the page on a permanent
  // skeleton: prior to this we just chained .then with no .catch, so a
  // network blip → loading=true forever and the operator gets no signal.
  useEffect(() => {
    let cancelled = false;
    apiGet<InboxResponse>("/runner/data/inbox")
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return;
        const message = fetchError instanceof Error ? fetchError.message : "Failed to load at-risk threads";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => data?.rows.filter((row) => row.riskLevel !== "GREEN") ?? [], [data]);

  const groupedReasons = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = row.riskReason || "Unread inbound waiting > 6h";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([reason, count]) => ({ reason, count }));
  }, [rows]);

  const focusThread = rows[focusIndex];

  if (loading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold">At Risk</h2>
        </div>
        <Card className="border-rose-200 bg-rose-50/60">
          <p className="text-sm font-semibold text-rose-900">Could not load at-risk threads</p>
          <p className="mt-1 text-sm text-rose-800">{error}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">At Risk</h2>
        <p className="text-sm text-slate-500">These threads are waiting on us. The goal is simple: keep our reply times tight.</p>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 space-y-2 lg:col-span-7">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Risk Queue</h3>
            <Button variant="primary" onClick={() => setFocusOpen(true)}>
              <PlayCircle className="mr-2 h-4 w-4" />
              Reply Focus Mode
            </Button>
          </div>
          {rows.map((row) => (
            <button
              key={row.id}
              className="mb-2 flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-left hover:bg-slate-100"
              onClick={() => router.push(`/thread/${row.id}`)}
            >
              <div>
                <p className="font-medium text-slate-900">{row.personName}</p>
                <p className="text-xs text-slate-500">{row.platform} • {row.slaCountdown}</p>
              </div>
              <div className="text-right">
                <Badge tone={row.riskLevel === "RED" ? "red" : "amber"}>{row.riskLevel}</Badge>
                <p className="mt-1 text-xs text-slate-500">Inbound {formatRelative(row.lastInboundAt)}</p>
              </div>
            </button>
          ))}
          {!rows.length ? <p className="text-sm text-slate-500">No at-risk threads right now.</p> : null}
        </Card>

        <Card className="col-span-12 lg:col-span-5">
          <h3 className="mb-3 text-lg font-semibold">Why they&apos;re at risk</h3>
          <div className="space-y-2">
            {groupedReasons.map((entry) => (
              <div key={entry.reason} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <span>{entry.reason}</span>
                <Badge>{entry.count}</Badge>
              </div>
            ))}
          </div>

          <h4 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">Top overdue</h4>
          <div className="mt-2 space-y-2">
            {rows.slice(0, 5).map((row) => (
              <div key={row.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <p className="text-sm font-medium">{row.personName}</p>
                <p className="text-xs text-slate-500">{row.slaCountdown}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {focusOpen && focusThread ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-10">
          <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-semibold">Reply Focus Mode</h3>
            <p className="mt-1 text-sm text-slate-500">One thread at a time. Keep our response loop tight.</p>
            <Card className="mt-4">
              <p className="font-medium">{focusThread.personName}</p>
              <p className="text-sm text-slate-600">{focusThread.preview}</p>
              <div className="mt-3 flex items-center gap-2">
                <Badge tone={focusThread.riskLevel === "RED" ? "red" : "amber"}>{focusThread.riskLevel}</Badge>
                <Badge>{focusThread.slaCountdown}</Badge>
              </div>
            </Card>
            <div className="mt-4 flex justify-between">
              <Button variant="secondary" onClick={() => setFocusOpen(false)}>
                Close
              </Button>
              <div className="space-x-2">
                <Button
                  variant="secondary"
                  onClick={() => setFocusIndex((value) => (value + 1 >= rows.length ? 0 : value + 1))}
                >
                  Next thread
                </Button>
                <Button variant="primary" onClick={() => router.push(`/thread/${focusThread.id}`)}>
                  Open thread
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
