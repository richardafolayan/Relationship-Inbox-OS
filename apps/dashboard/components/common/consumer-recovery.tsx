"use client";

import Link from "next/link";
import type { ConsumerFailure } from "@/lib/consumer-failure";

interface ConsumerRecoveryProps {
  failure: ConsumerFailure;
  compact?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  retryingLabel?: string;
  actionLabel?: string;
  className?: string;
}

export function ConsumerRecovery({
  failure,
  compact = false,
  onRetry,
  retrying = false,
  retryingLabel = "Trying again…",
  actionLabel,
  className = ""
}: ConsumerRecoveryProps) {
  const label = actionLabel ?? failure.actionLabel ?? "Try again";
  const uncertainty = failure.deliveryUncertain
    ? "Delivery is uncertain. Check the conversation before sending again."
    : failure.dataUncertain
      ? "Recent changes may not have been saved."
      : null;

  return (
    <section
      role="alert"
      aria-live="polite"
      data-consumer-failure={failure.code}
      className={`${compact ? "px-4 py-3" : "px-5 py-5"} rounded-row border border-hairline-strong bg-paper-2 text-ink shadow-sm ${className}`}
    >
      <div className={compact ? "flex flex-wrap items-center gap-x-4 gap-y-2" : "flex flex-col gap-3"}>
        <div className="min-w-0 flex-1">
          <p className={`${compact ? "text-[13px]" : "text-[16px]"} m-0 font-medium text-ink`}>
            {failure.title}
          </p>
          <p className={`${compact ? "mt-0.5 text-[12px]" : "mt-1 text-[13px]"} m-0 leading-[1.5] text-ink-3`}>
            {failure.message} {failure.nextAction}
          </p>
          {uncertainty ? (
            <p className="m-0 mt-1 text-[12px] font-medium leading-[1.45] text-ink-2">
              {uncertainty}
            </p>
          ) : null}
        </div>
        {onRetry || failure.actionHref ? (
          <div className="flex shrink-0 items-center gap-2">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="rounded-pill border border-hairline-strong bg-paper px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-calm hover:text-ink disabled:opacity-60"
              >
                {retrying ? retryingLabel : label}
              </button>
            ) : null}
            {failure.actionHref ? (
              <Link
                href={failure.actionHref}
                className="rounded-pill border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink"
              >
                {failure.actionLabel ?? "Open"}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
