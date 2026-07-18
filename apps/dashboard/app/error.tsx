"use client";

import { useEffect, useMemo } from "react";
import { ConsumerRecovery } from "@/components/common/consumer-recovery";
import { classifyConsumerFailure, logConsumerFailure } from "@/lib/consumer-failure";

export default function ErrorPage({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const failure = useMemo(
    () => classifyConsumerFailure(error, { method: "GET", phase: "runtime" }),
    [error]
  );

  useEffect(() => {
    logConsumerFailure(failure, error, {
      method: "GET",
      phase: "runtime",
      diagnostic: error.digest ? `${error.message} [digest ${error.digest}]` : error.message
    });
  }, [error, failure]);

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">
      <div className="mx-auto flex min-h-full w-full max-w-[620px] items-start px-4 pb-[calc(76px+env(safe-area-inset-bottom))] pt-8 sm:px-10 sm:py-16">
        <ConsumerRecovery failure={failure} onRetry={reset} actionLabel="Try this page again" />
      </div>
    </div>
  );
}
