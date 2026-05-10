"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { AuditLogRow } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

// Activity log - receipts list using the same row pattern. Click any row
// to inspect details/screenshots/DOM dumps in the receipts drawer.

// Render an audit-log action key as something an operator can scan.
// Action keys come from the runner as raw enums (e.g.
// `POST_PERSON_:PERSONID_PROFILE_URL_END`, `CONNECT_BROWSER_LAUNCH_OK`,
// `SCAN_END`). Without this they read like internal tokens.
function prettyAction(action: string): string {
  // Drop the `POST_` / `GET_` HTTP-method prefix on control-route audits.
  let label = action.replace(/^(POST|GET|PUT|DELETE|PATCH)_/, "");
  // Strip the parameter-placeholder tokens the runner inserts to keep
  // the action constant across IDs. `:personId` survives the audit
  // build's non-alphanumeric scrub as a bare uppercase `PERSONID` token,
  // so we drop those known names directly.
  label = label.replace(/_(PERSONID|THREADID|JOBID|REQUESTID)(?=_|$)/g, "");
  // Title-case each underscore-segment so the result looks like
  // "Person Profile Url End" instead of "PERSON_PROFILE_URL_END".
  return label
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

export default function LogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refresh = useCallback(async () => {
    const rows = await apiGet<AuditLogRow[]>("/runner/data/logs?limit=300").catch(
      () => [] as AuditLogRow[]
    );
    setLogs(rows);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  return (
    <Canvas>
      <PageHead
        eyebrow="Receipts"
        title="Activity"
        subtitle="Every scan, send, and selector check the runner has performed. Useful for debugging."
        meta={
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 hover:text-ink"
          >
            open drawer
          </button>
        }
      />

      {logs.length === 0 ? (
        <CaughtUp title="Nothing logged yet." body="Every scan, send, and selector check will appear here." />
      ) : (
        <div className="flex flex-col">
          {logs.map((log) => {
            const isFail = log.status !== "OK";
            const dot = isFail ? "bg-risk-overdue" : "bg-risk-fresh";
            const outcomeText = isFail ? "FAIL" : "OK";
            const outcomeClass = isFail
              ? "text-risk-overdue"
              : "text-risk-fresh";
            const hasArtifacts = !!(log.screenshotFile || log.domDumpFile);
            return (
              <div
                key={log.id}
                className="grid grid-cols-[160px_1fr_auto_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
              >
                <span className="font-mono text-[12px] tracking-[0.02em] text-ink-3">
                  {formatRelative(log.timestamp)}
                </span>
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 text-[15px] tracking-[-0.01em] text-ink" title={log.action}>
                    <span className={`h-[6px] w-[6px] rounded-full ${dot}`} />
                    {prettyAction(log.action)}
                  </p>
                  <p className="m-0 mt-1 font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    {log.platform ? `${log.platform.toLowerCase()} · ` : ""}
                    {log.stage ?? "general"}
                  </p>
                </div>
                <span
                  className={`font-mono text-[11px] uppercase tracking-[0.08em] ${outcomeClass}`}
                >
                  {outcomeText}
                </span>
                <div className="flex items-center gap-3 font-mono text-[11px] text-ink-3">
                  {log.screenshotFile ? (
                    <a
                      className="hover:text-ink hover:underline"
                      href={`/artifacts/screenshots/${log.screenshotFile}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      screenshot
                    </a>
                  ) : null}
                  {log.domDumpFile ? (
                    <a
                      className="hover:text-ink hover:underline"
                      href={`/artifacts/dom_dumps/${log.domDumpFile}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      dom
                    </a>
                  ) : null}
                  {!hasArtifacts ? <span className="text-ink-4">-</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ReceiptsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        rows={logs}
        title="System receipts"
      />
    </Canvas>
  );
}
