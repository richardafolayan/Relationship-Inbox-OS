"use client";

// /inbox is now a thin redirector to the 3-column thread view. Clicking
// "Inbox" in the sidebar lands the operator straight in the threads UI
// with the top thread auto-selected, instead of forcing a two-step
// "see the table → click someone → reach the threads view" flow.
//
// Top thread is whatever the runner returns first from /data/inbox; the
// runner already sorts genuine ahead of outreach + most-recent first.
// If the inbox is empty (no threads yet), we render a friendly empty
// state so the user has somewhere to land.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function InboxRedirectPage() {
  const router = useRouter();
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
        if (cancelled) return;
        const topId = inbox.rows[0]?.id;
        if (topId) {
          router.replace(`/thread/${topId}`);
          return;
        }
        setEmpty(true);
      } catch (refreshError) {
        if (cancelled) return;
        const message = refreshError instanceof Error ? refreshError.message : "Failed to load inbox";
        setError(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-slate-900">Runner unavailable</p>
          <p className="mt-1 text-sm text-slate-500">
            Could not reach the runner on <code>localhost:4001</code>. {error}
          </p>
          <div className="mt-3">
            <Button onClick={() => window.location.reload()}>Retry</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="space-y-4">
        <Card>
          <p className="text-sm font-semibold text-slate-900">Inbox is empty</p>
          <p className="mt-1 text-sm text-slate-500">
            No threads yet. Trigger a scan from the sidebar to pull in conversations from connected platforms.
          </p>
        </Card>
      </div>
    );
  }

  // Brief redirect state. Layout-shaped skeleton matches the 3-column
  // thread view we're about to land on, so there's no jarring jump.
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-4">
        <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-3">
          <Skeleton className="mb-3 h-4 w-20" />
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </Card>
        <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-6">
          <Skeleton className="mb-3 h-6 w-48" />
          <div className="flex-1 space-y-3">
            <Skeleton className="ml-0 h-16 w-3/4" />
            <Skeleton className="ml-auto h-16 w-2/3" />
            <Skeleton className="ml-0 h-12 w-1/2" />
          </div>
        </Card>
        <Card className="col-span-12 flex min-h-0 flex-col space-y-3 overflow-y-auto lg:col-span-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-16 w-full" />
        </Card>
      </div>
    </div>
  );
}
