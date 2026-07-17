"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  capturePwaStandaloneSnapshotFromWindow,
  logPwaStandaloneSnapshot,
  syncPwaDebugFromLocation
} from "@/lib/pwa-standalone-debug";

// Opt-in iPhone PWA verification aid. Enable with ?pwaDebug=1 (persists in
// sessionStorage across client navigations); disable with ?pwaDebug=0.
// Logs href, origin, display-mode standalone, and navigator.standalone on
// every route change so a failing route can be compared to a working one.
export function PwaStandaloneDebug(): null {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const enabled = syncPwaDebugFromLocation(
      window.location.search,
      window.sessionStorage
    );
    if (!enabled) return;
    logPwaStandaloneSnapshot(
      capturePwaStandaloneSnapshotFromWindow(window, pathname)
    );
  }, [pathname]);

  return null;
}
