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
    <div className="mx-auto w-full max-w-[620px] px-5 py-16 sm:px-10">
      <ConsumerRecovery failure={failure} onRetry={reset} actionLabel="Try this page again" />
    </div>
  );
}
