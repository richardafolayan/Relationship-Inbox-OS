"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<InboxResponse["rows"]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void apiGet<InboxResponse>("/runner/data/inbox").then((data) => setThreads(data.rows.slice(0, 30)));
  }, [open]);

  const commands = useMemo(() => {
    const core = [
      {
        id: "scan",
        title: "Run scan now",
        action: async () => {
          await apiPost("/runner/control/scan", {});
        }
      },
      {
        id: "platforms",
        title: "Open Platforms",
        action: async () => {
          router.push("/platforms");
        }
      },
      {
        id: "inbox",
        title: "Open Inbox",
        action: async () => {
          router.push("/inbox");
        }
      }
    ];

    const threadCommands = threads.map((thread) => ({
      id: `thread-${thread.id}`,
      title: `Jump to ${thread.personName}`,
      action: async () => {
        router.push(`/thread/${thread.id}`);
      }
    }));

    const all = [...core, ...threadCommands];
    if (!query.trim()) {
      return all;
    }

    return all.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  }, [query, router, threads]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/30 p-8">
      <div className="mx-auto mt-20 max-w-2xl rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-slate-400" />
          <Input placeholder="Jump to thread, run scan, open platforms..." value={query} onChange={(event) => setQuery(event.target.value)} />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="max-h-[420px] space-y-2 overflow-y-auto">
          {commands.map((command) => (
            <button
              key={command.id}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
              onClick={async () => {
                await command.action();
                onClose();
              }}
            >
              {command.title}
            </button>
          ))}

          {!commands.length ? <p className="text-sm text-slate-500">No commands found.</p> : null}
        </div>
      </div>
    </div>
  );
}
