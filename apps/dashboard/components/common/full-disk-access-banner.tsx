"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { selectImessageFdaRecovery } from "@/lib/imessage-fda";
import { Button } from "@/components/ui/button";
import type { PlatformCard } from "@/lib/types";
import { APP_NAME } from "@/lib/branding";

// App-wide recovery banner for the "an update reset macOS Full Disk Access"
// case. A dev auto-update re-signs Tovi ad-hoc, which changes the app's code
// hash; macOS keys Full Disk Access to that hash for ad-hoc apps, so the
// previously granted access silently stops matching and iMessage can no longer
// read chat.db. That surfaced only as a generic per-thread "needs reconnecting"
// error plus a note buried in Settings. This banner makes the fix obvious from
// any page: open Full Disk Access, re-grant, quit and reopen.
//
// It fires only when iMessage was connected before (selectImessageFdaRecovery
// gates on connectedAt), so a first-run "never granted" state stays in Settings
// where the setup guidance lives.

const DISMISS_KEY = "imessage_fda_banner_dismissed";
const POLL_INTERVAL_MS = 8000;

interface FullDiskAccessResponse {
  message?: string;
  runnerProcess?: PlatformCard["runnerProcess"];
}

export function FullDiskAccessBanner() {
  const [platforms, setPlatforms] = useState<PlatformCard[] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openedNote, setOpenedNote] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  const refresh = useCallback(async () => {
    // Short TTL so this de-dupes with TopStatus's own /data/platforms poll
    // via the shared client cache rather than issuing a parallel request.
    const data = await apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }).catch(
      () => null
    );
    if (data) setPlatforms(data);
  }, []);

  useVisiblePolling(() => void refresh(), POLL_INTERVAL_MS);

  // Refresh promptly when a scan finishes so the banner clears the moment
  // iMessage reconnects after the operator re-grants access and reopens.
  useEffect(() => {
    const onEvent = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type === "SCAN_FINISHED" || type === "THREAD_UPDATED") {
        void refresh();
      }
    };
    window.addEventListener("runner-event", onEvent as EventListener);
    return () => window.removeEventListener("runner-event", onEvent as EventListener);
  }, [refresh]);

  const recovery = selectImessageFdaRecovery(platforms);

  const onOpenFullDiskAccess = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      const result = await apiPost<FullDiskAccessResponse>(
        "/runner/control/imessage/full-disk-access",
        {}
      );
      const name = result.runnerProcess?.executableName ?? APP_NAME;
      const path = result.runnerProcess?.executablePath;
      setOpenedNote(
        path
          ? `Opened Full Disk Access. Remove ${name} if it is listed, then add it again and turn it on. macOS may show it as ${name}: ${path}. After that, quit ${APP_NAME} fully and reopen it.`
          : result.message ??
              `Opened Full Disk Access. Remove ${APP_NAME} if it is listed, then add it again and turn it on. After that, quit ${APP_NAME} fully and reopen it.`
      );
    } catch {
      setOpenedNote(
        `Could not open Full Disk Access automatically. Open System Settings, then Privacy and Security, then Full Disk Access, and re-grant ${APP_NAME} there.`
      );
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const onDismiss = useCallback(() => {
    window.sessionStorage.setItem(DISMISS_KEY, "true");
    setDismissed(true);
  }, []);

  if (!recovery || dismissed) return null;

  return (
    <div className="border-b border-hairline bg-paper px-3 py-2 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-row border border-[color-mix(in_srgb,var(--accent)_30%,var(--hairline))] bg-accent-soft px-5 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[14px] font-medium text-ink">
            iMessage lost access after the last update.
          </p>
          <p className="max-w-prose text-[12px] leading-[1.5] text-ink-2">
            {openedNote ??
              `The update reset macOS Full Disk Access, so ${APP_NAME} can no longer read Messages and cannot send or check iMessage. Re-grant Full Disk Access to fix it, then quit and reopen ${APP_NAME}.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void onOpenFullDiskAccess()}
            disabled={opening}
            className="px-[14px] py-[8px] text-[13px]"
          >
            {opening ? "Opening…" : "Open Full Disk Access"}
          </Button>
          <button
            type="button"
            onClick={onDismiss}
            className="font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
