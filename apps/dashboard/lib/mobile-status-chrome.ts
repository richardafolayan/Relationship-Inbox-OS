// Route-aware mobile status chrome (#914).
// Desktop always keeps the full TopStatus row; mobile density depends on
// the route so secondary screens reclaim vertical space for content.

export type MobileStatusChrome = "full" | "compact" | "hidden";

/**
 * Decide how dense the global status row should be below the md breakpoint.
 * - full: Today operational home
 * - compact: Inbox (connection + scan without the full chrome)
 * - hidden: secondary screens (thread, archived, reconnect, settings, …)
 *   unless something needs attention (see shouldSurfaceHiddenStatus)
 */
export function resolveMobileStatusChrome(pathname: string | null | undefined): MobileStatusChrome {
  if (!pathname) return "full";

  if (pathname === "/today" || pathname.startsWith("/today/")) return "full";
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return "compact";

  // Secondary mobile screens listed in #914. Search is the command palette
  // overlay (not a route), so it is not listed here.
  if (
    pathname.startsWith("/thread/") ||
    pathname === "/archived" ||
    pathname.startsWith("/archived/") ||
    pathname === "/reconnect" ||
    pathname.startsWith("/reconnect/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
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
    case "send_failed":
      return true;
    default:
      return false;
  }
}
