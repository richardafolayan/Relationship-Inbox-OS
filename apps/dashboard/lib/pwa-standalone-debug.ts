export const PWA_DEBUG_STORAGE_KEY = "rios_pwa_debug";
export const PWA_DEBUG_QUERY = "pwaDebug";

export type PwaStandaloneSnapshot = {
  href: string;
  origin: string;
  pathname: string;
  standalone: boolean;
  iosStandalone: boolean | null;
};

export function parsePwaDebugQuery(
  search: string
): "on" | "off" | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const value = new URLSearchParams(raw).get(PWA_DEBUG_QUERY);
  if (value === "1" || value === "true") return "on";
  if (value === "0" || value === "false") return "off";
  return null;
}

export function syncPwaDebugFromLocation(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
): boolean {
  const flag = parsePwaDebugQuery(search);
  if (flag === "on") {
    try {
      storage?.setItem(PWA_DEBUG_STORAGE_KEY, "1");
    } catch {
      // private mode
    }
    return true;
  }
  if (flag === "off") {
    try {
      storage?.removeItem(PWA_DEBUG_STORAGE_KEY);
    } catch {
      // private mode
    }
    return false;
  }
  try {
    return storage?.getItem(PWA_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function readPwaDebugEnabled(
  search: string,
  storage: Pick<Storage, "getItem"> | null
): boolean {
  if (parsePwaDebugQuery(search) === "on") return true;
  if (parsePwaDebugQuery(search) === "off") return false;
  try {
    return storage?.getItem(PWA_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function capturePwaStandaloneSnapshot(input: {
  href: string;
  origin: string;
  pathname: string;
  matchMediaStandalone: boolean;
  iosStandalone: boolean | null;
}): PwaStandaloneSnapshot {
  return {
    href: input.href,
    origin: input.origin,
    pathname: input.pathname,
    standalone: input.matchMediaStandalone,
    iosStandalone: input.iosStandalone
  };
}

export function capturePwaStandaloneSnapshotFromWindow(
  win: Window,
  pathname?: string
): PwaStandaloneSnapshot {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return capturePwaStandaloneSnapshot({
    href: win.location.href,
    origin: win.location.origin,
    pathname: pathname ?? win.location.pathname,
    matchMediaStandalone: win.matchMedia("(display-mode: standalone)").matches,
    iosStandalone: typeof nav.standalone === "boolean" ? nav.standalone : null
  });
}

export function formatPwaStandaloneLog(snapshot: PwaStandaloneSnapshot): string {
  return [
    "[pwa-debug]",
    `href=${snapshot.href}`,
    `origin=${snapshot.origin}`,
    `pathname=${snapshot.pathname}`,
    `standalone=${snapshot.standalone}`,
    `iosStandalone=${snapshot.iosStandalone}`
  ].join(" ");
}

export function logPwaStandaloneSnapshot(
  snapshot: PwaStandaloneSnapshot,
  log: (...args: unknown[]) => void = console.info
): void {
  log(formatPwaStandaloneLog(snapshot), snapshot);
}
