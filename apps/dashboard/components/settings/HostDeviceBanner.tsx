"use client";

import { cn } from "@/lib/utils";
import type { HostDeviceState } from "@/lib/use-host-device";

export function HostDeviceBanner({
  host,
  className
}: {
  host: HostDeviceState;
  className?: string;
}) {
  const online = host.online === true;
  const offline = host.online === false;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-[10px] border border-hairline bg-paper-2/55 px-4 py-3",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "mt-[5px] h-2 w-2 shrink-0 rounded-full",
            online
              ? "bg-risk-fresh"
              : offline
                ? "bg-ink-3"
                : "bg-ink-3/60"
          )}
        />
        <div className="min-w-0">
          <p className="m-0 text-[14px] font-medium text-ink">{host.runsOn}</p>
          <p className="m-0 mt-0.5 text-[12.5px] leading-[1.45] text-ink-3">
            {host.statusLine}
          </p>
          {offline ? (
            <p className="m-0 mt-2 text-[12.5px] leading-[1.45] text-ink-2">
              {host.offlineExplanation}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
