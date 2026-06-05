import type { Response } from "express";
import type { SettingsStore } from "../types/runtime";

/**
 * Per-mutation safety check for the full presenter demo. Three-state:
 *
 *  - `presenterReadOnly === true` (live demo) — every guarded endpoint is
 *    rejected with 403 `presenter-readonly`. Used so a stray request from
 *    a stale dashboard tab can never archive / send / snooze a real
 *    thread during a presentation.
 *
 *  - `presenterDemoMode === "sandbox"` — adapter-touching actions (scan,
 *    rescan, platform connect, test-selectors, reconnect refresh, closed-
 *    status refresh) are rejected with 403 `demo-mode-external-blocked`.
 *    Thread / person mutations are allowed ONLY when the target is in the
 *    seeded demo manifest; otherwise rejected with 403
 *    `demo-mode-foreign-thread`. `operator-write` kind is allowed (the
 *    operator profile is a local Setting row, not a per-thread mutation).
 *
 *  - everything else — pass-through.
 *
 * Returns `true` when the request was rejected (the route should return
 * immediately) and `false` when the route should continue.
 *
 * IMPORTANT: `POST /control/settings` and `POST /control/presenter-demo/reset`
 * are NEVER wrapped by this guard — they are the exit paths the operator
 * uses to leave demo mode and must remain reachable in every state.
 */
export type PresenterGuardKind = "thread-mutation" | "external-action" | "operator-write";

export interface PresenterGuardOpts {
  /** Required for `kind: "thread-mutation"` when target is a thread. */
  threadId?: string;
  /** Required for `kind: "thread-mutation"` when target is a person. */
  personId?: string;
  /** Short verb for the toast / log, e.g. "send", "archive", "snooze". */
  action: string;
  kind: PresenterGuardKind;
}

export async function checkPresenterGuard(
  res: Response,
  settingsStore: SettingsStore,
  opts: PresenterGuardOpts
): Promise<boolean> {
  const settings = await settingsStore.getSettings();

  if (settings.presenterReadOnly) {
    res.status(403).json({ error: "presenter-readonly", action: opts.action });
    return true;
  }

  if (settings.presenterDemoMode === "sandbox") {
    if (opts.kind === "external-action") {
      res.status(403).json({ error: "demo-mode-external-blocked", action: opts.action });
      return true;
    }
    if (opts.kind === "thread-mutation") {
      const manifest = await settingsStore.getDemoSeedManifest();
      const threadOk = opts.threadId && manifest?.threadIds.includes(opts.threadId);
      const personOk = opts.personId && manifest?.personIds.includes(opts.personId);
      if (!manifest || (!threadOk && !personOk)) {
        res.status(403).json({ error: "demo-mode-foreign-thread", action: opts.action });
        return true;
      }
    }
    // operator-write falls through — a local Setting row, no platform fan-out.
  }

  return false;
}
