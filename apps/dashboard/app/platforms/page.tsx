"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AuditLogRow, PlatformCard } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { DegradedBanner } from "@/components/common/degraded-banner";

function statusTone(status: PlatformCard["status"]): "green" | "amber" | "red" | "neutral" {
  if (status === "CONNECTED") {
    return "green";
  }
  if (status === "DEGRADED") {
    return "amber";
  }
  if (status === "ERROR") {
    return "red";
  }
  return "neutral";
}

export default function PlatformsPage() {
  const [rows, setRows] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [editingSelector, setEditingSelector] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [platforms, logRows] = await Promise.all([
      apiGet<PlatformCard[]>("/runner/data/platforms"),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150")
    ]);
    setRows(platforms);
    setLogs(logRows);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onResync = () => {
      void refresh();
    };

    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Platforms</h2>
        <p className="text-sm text-slate-500">Transparent platform control, selector checks, and session trust signals.</p>
      </div>

      {rows
        .filter((row) => row.status === "DEGRADED")
        .map((row) => (
          <DegradedBanner
            key={row.platform}
            platform={row.platform}
            onOpenReceipts={() => setReceiptsOpen(true)}
            onRunSelectorTests={() => void apiPost("/runner/control/platform/test-selectors", { platform: row.platform }).then(refresh)}
            domDumpFile={logs.find((log) => log.platform === row.platform && log.domDumpFile)?.domDumpFile}
          />
        ))}

      <div className="space-y-4">
        {rows.map((row) => (
          <Card key={row.platform}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">{row.platform}</h3>
                <div className="mt-1 flex items-center gap-2">
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <span className="text-sm text-slate-500">Last scan {formatRelative(row.lastScanAt)}</span>
                </div>
                {row.lastError ? <p className="mt-2 text-sm text-rose-600">{row.lastError}</p> : null}
                <p className="mt-2 text-xs text-slate-500">Profile: {row.profileDir}</p>
                <p className="mt-1 text-xs text-slate-500">
                  Browser mode:{" "}
                  {row.browserProfileMode === "personal"
                    ? `Personal (${row.browserProfileDirectory ?? "Person 1"}${row.browserProfileName ? `, ${row.browserProfileName}` : ""})`
                    : "Isolated automation profile"}
                </p>
                {row.browserProfileMode === "personal" ? (
                  <>
                    <p className="mt-1 text-xs text-slate-500">Sync mode: {row.browserProfileSyncMode ?? "smart"}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      Source user-data dir: {row.browserProfileSourceUserDataDir ?? "n/a"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Launch user-data dir: {row.browserProfileLaunchUserDataDir ?? "n/a"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Profile resolution: {row.browserProfileResolutionStrategy ?? "n/a"}
                    </p>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => void apiPost("/runner/control/platform/connect", { platform: row.platform }).then(refresh)}
                >
                  {row.status === "CONNECTED" ? "Reconnect" : "Connect"}
                </Button>
                <Button variant="secondary" onClick={() => void apiPost("/runner/control/scan", { platform: row.platform })}>
                  Run scan
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void apiPost("/runner/control/platform/open-browser", { platform: row.platform })}
                >
                  Open browser window
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void apiPost("/runner/control/platform/test-selectors", { platform: row.platform }).then(refresh)
                  }
                >
                  Run selector tests
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!confirm(`Reset ${row.platform} session? This wipes local profile state.`)) {
                      return;
                    }
                    void apiPost("/runner/control/platform/reset-session", { platform: row.platform }).then(refresh);
                  }}
                >
                  Reset session
                </Button>
              </div>
            </div>

            {row.latestSelectorReport ? (
              <div className="mt-4 rounded-xl border border-slate-200">
                <div className="grid grid-cols-[1fr_2fr_1fr_1fr_2fr] gap-2 border-b border-slate-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  <span>Selector key</span>
                  <span>Selector</span>
                  <span>Count</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {row.latestSelectorReport.results.map((result) => {
                  const editKey = `${row.platform}:${result.key}`;
                  const edited = editingSelector[editKey] ?? result.selector;

                  return (
                    <div key={result.key} className="grid grid-cols-[1fr_2fr_1fr_1fr_2fr] gap-2 border-b border-slate-100 px-3 py-2 text-sm">
                      <span className="font-medium text-slate-700">{result.key}</span>
                      <Input value={edited} onChange={(event) => setEditingSelector((prev) => ({ ...prev, [editKey]: event.target.value }))} />
                      <span className="text-slate-600">{result.count}</span>
                      <span>
                        <Badge tone={result.status === "PASS" ? "green" : "red"}>{result.status}</Badge>
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void apiPost("/runner/control/platform/test-selectors", {
                              platform: row.platform,
                              key: result.key,
                              selector: edited
                            }).then(refresh)
                          }
                        >
                          Test this selector
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void apiPost("/runner/control/platform/save-selector-override", {
                              platform: row.platform,
                              key: result.key,
                              selector: edited
                            }).then(refresh)
                          }
                        >
                          Save override
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void apiPost("/runner/control/platform/reset-selector-override", {
                              platform: row.platform,
                              key: result.key
                            }).then(refresh)
                          }
                        >
                          Reset to default
                        </Button>
                        {result.screenshotFile ? (
                          <a className="text-xs font-medium text-blue-700 hover:underline" href={`/artifacts/screenshots/${result.screenshotFile}`} target="_blank">
                            Screenshot
                          </a>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No selector report yet. Run selector tests to generate one.</p>
            )}
          </Card>
        ))}
      </div>

      <ReceiptsDrawer open={receiptsOpen} onClose={() => setReceiptsOpen(false)} rows={logs} title="Platform receipts" />
    </div>
  );
}
