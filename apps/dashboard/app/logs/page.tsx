"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { AuditLogRow } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

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
    const rows = await apiGet<AuditLogRow[]>("/runner/data/logs?limit=300");
    setLogs(rows);
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Activity Log</h2>
          <p className="text-sm text-slate-500">Receipts-first trace of scans, sends, selector checks, and failures.</p>
        </div>
        <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
          Open receipts drawer
        </Button>
      </div>

      <Card>
        <div className="grid grid-cols-[200px_110px_120px_1fr_90px_140px] gap-3 border-b border-slate-200 px-3 pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          <span>Timestamp</span>
          <span>Platform</span>
          <span>Stage</span>
          <span>Action</span>
          <span>Outcome</span>
          <span>Artifacts</span>
        </div>

        <div className="mt-2 space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="grid grid-cols-[200px_110px_120px_1fr_90px_140px] gap-3 items-center rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <span className="text-slate-700">{new Date(log.timestamp).toLocaleString("en-GB")}</span>
              <span className="text-slate-600">{log.platform ?? "-"}</span>
              <span className="text-slate-600">{log.stage ?? "-"}</span>
              <span className="font-medium text-slate-800" title={log.action}>
                {prettyAction(log.action)}
              </span>
              <span>
                <Badge tone={log.status === "OK" ? "green" : "red"}>{log.status}</Badge>
              </span>
              <span className="flex items-center gap-2 text-xs">
                {log.screenshotFile ? (
                  <a className="font-medium text-blue-700 hover:underline" href={`/artifacts/screenshots/${log.screenshotFile}`} target="_blank">
                    Screenshot
                  </a>
                ) : null}
                {log.domDumpFile ? (
                  <a className="font-medium text-blue-700 hover:underline" href={`/artifacts/dom_dumps/${log.domDumpFile}`} target="_blank">
                    DOM
                  </a>
                ) : null}
              </span>
            </div>
          ))}

          {!logs.length ? <p className="text-sm text-slate-500">No activity yet.</p> : null}
        </div>
      </Card>

      <ReceiptsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} rows={logs} title="System receipts" />
    </div>
  );
}
