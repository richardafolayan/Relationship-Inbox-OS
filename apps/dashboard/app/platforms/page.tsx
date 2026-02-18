"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, apiGet, apiPost } from "@/lib/api";
import type {
  AuditLogRow,
  PlatformCard,
  SelectorTestFailurePayload,
  SelectorTestSuccessPayload
} from "@/lib/types";
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
  const [selectorErrors, setSelectorErrors] = useState<Record<string, SelectorTestFailurePayload | undefined>>({});

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

  const normalizeSelectorError = useCallback((platform: PlatformCard["platform"], error: unknown): SelectorTestFailurePayload => {
    if (error instanceof ApiRequestError && error.payload && typeof error.payload === "object") {
      const payload = error.payload as Partial<SelectorTestFailurePayload>;
      if (payload.ok === false && payload.stage && payload.error && payload.requestId) {
        return {
          ok: false,
          platform: payload.platform ?? platform,
          stage: payload.stage,
          error: payload.error,
          requestId: payload.requestId,
          reason: payload.reason,
          receipts: payload.receipts,
          artifacts: payload.artifacts
        };
      }
    }

    return {
      ok: false,
      platform,
      stage: "persist",
      error: error instanceof Error ? error.message : String(error),
      requestId: crypto.randomUUID()
    };
  }, []);

  const runSelectorTests = useCallback(
    async (input: { platform: PlatformCard["platform"]; key?: string; selector?: string }) => {
      try {
        await apiPost<SelectorTestSuccessPayload>("/runner/control/platform/test-selectors", input);
        setSelectorErrors((prev) => ({ ...prev, [input.platform]: undefined }));
        await refresh();
      } catch (error) {
        setSelectorErrors((prev) => ({
          ...prev,
          [input.platform]: normalizeSelectorError(input.platform, error)
        }));
      }
    },
    [normalizeSelectorError, refresh]
  );

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
            stage={row.lastScanFailure?.stage}
            reason={row.lastScanFailure?.reason}
            requestId={row.lastScanFailure?.requestId}
            errorSummary={row.lastScanFailure?.errorSummary ?? row.lastError ?? undefined}
            screenshotFile={row.lastScanFailure?.screenshotFile}
            onOpenReceipts={() => setReceiptsOpen(true)}
            onRunSelectorTests={() => void runSelectorTests({ platform: row.platform })}
            domDumpFile={
              row.lastScanFailure?.domDumpFile ??
              logs.find((log) => log.platform === row.platform && log.domDumpFile)?.domDumpFile
            }
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
                {row.lastScanFailure ? (
                  <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                    <p className="font-medium">{row.lastScanFailure.errorSummary}</p>
                    <p className="mt-1">
                      Stage: {row.lastScanFailure.stage}
                      {row.lastScanFailure.reason ? ` · Reason: ${row.lastScanFailure.reason}` : ""}
                    </p>
                    <p className="mt-1">Request ID: {row.lastScanFailure.requestId}</p>
                    <div className="mt-1 flex gap-2">
                      {row.lastScanFailure.screenshotFile ? (
                        <a
                          className="text-blue-700 underline"
                          href={`/artifacts/screenshots/${row.lastScanFailure.screenshotFile}`}
                          target="_blank"
                        >
                          Failure screenshot
                        </a>
                      ) : null}
                      {row.lastScanFailure.domDumpFile ? (
                        <a
                          className="text-blue-700 underline"
                          href={`/artifacts/dom_dumps/${row.lastScanFailure.domDumpFile}`}
                          target="_blank"
                        >
                          Failure DOM dump
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : null}
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
                  onClick={() => void runSelectorTests({ platform: row.platform })}
                >
                  Run selector tests
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!confirm("Reset shared session context for all platforms? This wipes managed profile state.")) {
                      return;
                    }
                    void apiPost("/runner/control/platform/reset-session", { platform: row.platform }).then(refresh);
                  }}
                >
                  Reset shared session
                </Button>
              </div>
            </div>

            {selectorErrors[row.platform] ? (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                <p className="font-semibold">Selector tests failed</p>
                <p className="mt-1">
                  Stage: <span className="font-medium">{selectorErrors[row.platform]?.stage}</span>
                </p>
                <p className="mt-1">{selectorErrors[row.platform]?.error}</p>
                {selectorErrors[row.platform]?.reason ? (
                  <p className="mt-1 text-xs">Reason: {selectorErrors[row.platform]?.reason}</p>
                ) : null}
                <p className="mt-1 text-xs">Request ID: {selectorErrors[row.platform]?.requestId}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {selectorErrors[row.platform]?.artifacts?.screenshot ? (
                    <a
                      className="text-rose-700 underline"
                      href={`/artifacts/screenshots/${selectorErrors[row.platform]?.artifacts?.screenshot}`}
                      target="_blank"
                    >
                      Failure screenshot
                    </a>
                  ) : null}
                  {selectorErrors[row.platform]?.artifacts?.domDump ? (
                    <a
                      className="text-rose-700 underline"
                      href={`/artifacts/dom_dumps/${selectorErrors[row.platform]?.artifacts?.domDump}`}
                      target="_blank"
                    >
                      Failure DOM dump
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}

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
                          onClick={() => void runSelectorTests({ platform: row.platform, key: result.key, selector: edited })}
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
