// Route-aware mobile status chrome (#914).
// Desktop always keeps the full TopStatus row; mobile density depends on
// the route so secondary screens reclaim vertical space for content.

export type MobileStatusChrome = "full" | "compact" | "hidden";

/**
 * Decide how dense the global status row should be below the md breakpoint.
 * - full: transitional fallback before the route resolves
 * - compact: Today and Inbox, with attention and pilot feedback only
 * - hidden: secondary screens (thread, archived, reconnect, settings, …)
 *   unless something needs attention (see shouldSurfaceHiddenStatus)
 */
export function resolveMobileStatusChrome(pathname: string | null | undefined): MobileStatusChrome {
  if (!pathname) return "full";

  if (pathname === "/today" || pathname.startsWith("/today/")) return "compact";
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return "compact";

  // Secondary mobile screens listed in #914, plus the dedicated /search
  // route from #903. Healthy idle state stays chrome-free; offline,
  // degraded, or in-flight work still re-surfaces via shouldSurfaceHiddenStatus.
  //
  // /search note: dedicated Search paints a full-viewport overlay (z-90)
  // above shell TopStatus (z-30). forceSurface still returns true here so
  // the helper contract is correct, but the pilot-visible strip is owned
  // by the Search UI in-search attention banner (#903), not TopStatus
  // stacking. Do not rely on TopStatus alone for /search attention.
  if (
    pathname.startsWith("/thread/") ||
    pathname === "/archived" ||
    pathname.startsWith("/archived/") ||
    pathname === "/reconnect" ||
    pathname.startsWith("/reconnect/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/search" ||
    pathname.startsWith("/search/")
  ) {
    return "hidden";
  }

  // Other list/admin routes (people, at-risk, platforms, logs, demo) keep a
  // compact strip rather than the full operational chrome.
  return "compact";
}

export type StatusSurfaceSignals = {
  ready: boolean;
  runnerOffline: boolean;
  hasDegraded: boolean;
  /** ticker.kind from TopStatus */
  tickerKind: string;
};

export function shouldRenderStatusTicker(tickerKind: string, tickerIsActive: boolean): boolean {
  return (
    tickerIsActive ||
    tickerKind === "send_failed" ||
    tickerKind === "send_succeeded" ||
    tickerKind === "thread_checked" ||
    tickerKind === "thread_check_incomplete"
  );
}

/**
 * When mobile chrome is "hidden", only mount the status row if something
 * needs operator attention. Healthy idle state stays invisible so thread
 * and settings reclaim the 44px.
 */
export function shouldSurfaceHiddenStatus(signals: StatusSurfaceSignals): boolean {
  if (!signals.ready) return false;
  if (signals.runnerOffline) return true;
  if (signals.hasDegraded) return true;

  switch (signals.tickerKind) {
    case "scanning":
    case "sending":
    case "enriching":
    case "reassessing":
    case "sending_report":
    case "checking_thread":
    case "thread_check_incomplete":
    case "send_failed":
      return true;
    default:
      return false;
  }
}
