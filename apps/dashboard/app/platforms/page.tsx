"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, apiGet, apiPost, runAction } from "@/lib/api";
import type {
  AuditLogRow,
  PlatformCard,
  ScanControlBlockedResponse,
  ScanControlResponse,
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
  const [scanBlocks, setScanBlocks] = useState<Record<string, ScanControlBlockedResponse | undefined>>({});
  const [actionError, setActionError] = useState<string | null>(null);

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

  const runScan = useCallback(
    async (platform: PlatformCard["platform"]) => {
      try {
        const response = await apiPost<ScanControlResponse>("/runner/control/scan", { platform });
        if (!response.ok && response.blocked) {
          setScanBlocks((prev) => ({
            ...prev,
            [platform]: response
          }));
          return;
        }

        setScanBlocks((prev) => ({
          ...prev,
          [platform]: undefined
        }));
        await refresh();
      } catch {
        setScanBlocks((prev) => ({
          ...prev,
          [platform]: undefined
        }));
      }
    },
    [refresh]
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Platforms</h2>
        <p className="text-sm text-slate-500">Transparent platform control, selector checks, and session trust signals.</p>
      </div>

      {actionError ? (
        <Card className="border-rose-200 bg-rose-50/60">
          <p className="text-sm font-semibold text-rose-900">Action failed</p>
          <p className="mt-1 text-sm text-rose-800">{actionError}</p>
        </Card>
      ) : null}

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
                {row.lastError && row.status !== "DEGRADED" ? (
                  <p className="mt-2 text-sm text-rose-600">{row.lastError}</p>
                ) : null}
                {scanBlocks[row.platform] ? (
                  <p className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                    {scanBlocks[row.platform]?.reason === "in_flight"
                      ? `Scan already in flight - retry in ${scanBlocks[row.platform]?.retryAfterSeconds}s`
                      : `Cooling down - next retry in ${scanBlocks[row.platform]?.retryAfterSeconds}s`}
                  </p>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-500 marker:text-slate-400">
                    Profile details
                  </summary>
                  <div className="mt-2 space-y-1 text-xs text-slate-500">
                    <p>Profile: {row.profileDir}</p>
                    <p>
                      Browser mode:{" "}
                      {row.browserProfileMode === "personal"
                        ? `Personal (${row.browserProfileDirectory ?? "Person 1"}${row.browserProfileName ? `, ${row.browserProfileName}` : ""})`
                        : "Isolated automation profile"}
                    </p>
                    {row.browserProfileMode === "personal" ? (
                      <>
                        <p>Sync mode: {row.browserProfileSyncMode ?? "smart"}</p>
                        <p>Source user-data dir: {row.browserProfileSourceUserDataDir ?? "n/a"}</p>
                        <p>Launch user-data dir: {row.browserProfileLaunchUserDataDir ?? "n/a"}</p>
                        <p>Profile resolution: {row.browserProfileResolutionStrategy ?? "n/a"}</p>
                      </>
                    ) : null}
                  </div>
                </details>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  onClick={() =>
                    runAction(
                      apiPost("/runner/control/platform/connect", { platform: row.platform }),
                      setActionError,
                      refresh
                    )
                  }
                >
                  {row.status === "CONNECTED" ? "Reconnect" : "Connect"}
                </Button>
                <Button variant="secondary" onClick={() => void runScan(row.platform)}>
                  Run scan
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    runAction(
                      apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
                      setActionError
                    )
                  }
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
                    runAction(
                      apiPost("/runner/control/platform/reset-session", { platform: row.platform }),
                      setActionError,
                      refresh
                    );
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
                      target="_blank" rel="noopener noreferrer"
                    >
                      Failure screenshot
                    </a>
                  ) : null}
                  {selectorErrors[row.platform]?.artifacts?.domDump ? (
                    <a
                      className="text-rose-700 underline"
                      href={`/artifacts/dom_dumps/${selectorErrors[row.platform]?.artifacts?.domDump}`}
                      target="_blank" rel="noopener noreferrer"
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
                            runAction(
                              apiPost("/runner/control/platform/save-selector-override", {
                                platform: row.platform,
                                key: result.key,
                                selector: edited
                              }),
                              setActionError,
                              refresh
                            )
                          }
                        >
                          Save override
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            runAction(
                              apiPost("/runner/control/platform/reset-selector-override", {
                                platform: row.platform,
                                key: result.key
                              }),
                              setActionError,
                              refresh
                            )
                          }
                        >
                          Reset to default
                        </Button>
                        {result.screenshotFile ? (
                          <a className="text-xs font-medium text-blue-700 hover:underline" href={`/artifacts/screenshots/${result.screenshotFile}`} target="_blank" rel="noopener noreferrer">
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
