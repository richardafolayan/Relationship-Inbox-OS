"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { apiGet, apiPost } from "@/lib/api";
import type { AppSettings, InboxResponse } from "@/lib/types";
import { showToast } from "@/lib/feedback";
import {
  FULL_DEMO_SCRIPT,
  type DemoStep,
  type FullDemoMode,
  getStepIndex,
  isStepInMode
} from "@/lib/full-demo-script";
import {
  buildThreadIdMap,
  clearFullDemoState,
  readFullDemoState,
  threadIdMapsEqual,
  writeFullDemoState
} from "@/lib/full-demo-state";
import { installLiveDemoFetchInterceptor } from "@/lib/full-demo-fetch";
import { getDemoThreadIds, isDemoThread } from "@/lib/demo-threads";
import { dismissCenterNotifications } from "@/lib/notification-center";

/**
 * FullDemoProvider holds the runtime state for the full-presenter-demo
 * walkthrough. The server is the source of truth for whether presenter
 * mode is on (AppSettings.presenterDemoMode + presenterReadOnly); local
 * state tracks the user's place in the script and the autoplay toggle.
 *
 * On mount:
 *  - Reads /data/settings.
 *  - If server reports presenter on but localStorage state is missing,
 *    we render in "recovery" mode so the banner can offer a one-click exit.
 *  - In live mode, installs a window.fetch interceptor that blocks
 *    mutation requests with a toast.
 *
 * The provider is intentionally permissive about navigation: route
 * changes triggered by a step happen via Next's router so the rest of
 * the dashboard sees ordinary client-side transitions.
 */

/**
 * Which guided experience is currently driving the sandbox.
 *
 *  - "presenter": the full walkthrough (FullDemoOverlay renders).
 *  - "pilot": the first-run onboarding tour (PilotTour renders).
 *  - null: no walkthrough is running. If `serverSettings` still reports
 *    presenter flags on at this point, recovery is needed.
 *
 * Sandbox seeding/teardown is owned by the provider and shared by both
 * flows — only one flow can be active at a time.
 */
export type FullDemoFlow = "presenter" | "pilot" | null;

interface FullDemoContextValue {
  /** True only when the presenter walkthrough is running. */
  active: boolean;
  /** The currently driving flow, or null if nothing is running. */
  flow: FullDemoFlow;
  /** Walkthrough mode if presenter is active, otherwise null. */
  mode: FullDemoMode | null;
  /**
   * True while a guided flow is showing SANDBOX (demo-seeded) data: the pilot
   * tour, or the presenter walkthrough in sandbox mode. Today/Inbox narrow to
   * demo threads only while this is true, so the curated tour resolves its
   * targets regardless of how full the real inbox is. False in presenter live
   * / read-only mode, where real threads stay visible.
   */
  sandboxActive: boolean;
  /** Index into FULL_DEMO_SCRIPT, filtered to steps in the current mode. */
  stepIndex: number;
  /** Total visible steps in the current mode. */
  visibleStepCount: number;
  /** Current DemoStep if presenter is active, otherwise null. */
  currentStep: DemoStep | null;
  autoplay: boolean;
  /** Server settings as last fetched — used by banner + recovery surfaces. */
  serverSettings: AppSettings | null;
  /**
   * True when the server reports presenter on (presenterDemoMode !== "off"
   * OR presenterReadOnly === true) but no flow is locally active.
   * Banner / Settings shell uses this to offer a "Recover demo state"
   * one-click exit.
   */
  recoveryNeeded: boolean;
  liveThreadIds: string[];
  /** platformThreadId → internal cuid. Populated from /data/inbox while sandbox is active. */
  threadIdMap: Map<string, string>;

  start: (mode: FullDemoMode, liveThreadIds?: string[]) => Promise<void>;
  /**
   * Seed the sandbox without engaging the presenter walkthrough. Used by
   * the pilot tour, which drives its own GuidedTour overlay against the
   * same showcase data.
   */
  startPilotSandbox: () => Promise<void>;
  next: () => void;
  back: () => void;
  goToStepId: (stepId: string) => void;
  setAutoplay: (on: boolean) => void;
  exit: () => Promise<void>;
  /** Refetch /data/settings; used after exit / recovery. */
  refreshSettings: () => Promise<void>;
}

const FullDemoContext = createContext<FullDemoContextValue | null>(null);

const AUTOPLAY_DEFAULT_MS = 6000;

function presenterFlagsOn(settings: AppSettings | null): boolean {
  if (!settings) return false;
  return (settings.presenterDemoMode && settings.presenterDemoMode !== "off") || !!settings.presenterReadOnly;
}

// Starting / exiting a sandbox changes which threads the runner returns from
// /data/inbox (demo rows are seeded in, then torn down). Today and Inbox keep
// their own inbox copy and refetch on the "runner-resync" event, so nudge them
// once the seed/teardown has landed. Without this the sandbox filter runs
// against stale (real) data and Today renders empty during the tour.
function signalInboxResync(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("runner-resync"));
  }
}

export function FullDemoProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [flow, setFlow] = useState<FullDemoFlow>(null);
  const active = flow === "presenter";
  const [mode, setMode] = useState<FullDemoMode | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [autoplay, setAutoplayState] = useState(false);
  const [serverSettings, setServerSettings] = useState<AppSettings | null>(null);
  const [liveThreadIds, setLiveThreadIds] = useState<string[]>([]);
  const fetchInterceptorTeardownRef = useRef<(() => void) | null>(null);
  // Forward ref to `exit` so `next` (declared earlier) can trigger
  // teardown on the final step without a circular useCallback dep.
  const exitRef = useRef<(() => Promise<void>) | null>(null);
  // platformThreadId → internal thread id, populated from /data/inbox
  // when sandbox is active. The script references threads by their stable
  // platformThreadId; the dashboard /thread/[id] route wants the runner's
  // cuid. This map bridges the two without baking cuids into the script.
  const [threadIdMap, setThreadIdMap] = useState<Map<string, string>>(new Map());

  // --- localStorage hydration on mount -------------------------------------
  useEffect(() => {
    const initial = readFullDemoState();
    if (initial.active) {
      setFlow("presenter");
      setMode(initial.mode);
      setStepId(initial.stepId);
      setAutoplayState(initial.autoplay);
      setLiveThreadIds(initial.liveThreadIds);
    }
  }, []);

  // --- server settings poll on mount ---------------------------------------
  const refreshSettings = useCallback(async () => {
    try {
      const fresh = await apiGet<AppSettings>("/runner/data/settings");
      setServerSettings(fresh);
    } catch {
      /* leave previous settings */
    }
  }, []);
  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  // --- live-mode fetch interceptor lifecycle -------------------------------
  useEffect(() => {
    const liveActive = active && mode === "live";
    if (liveActive) {
      const teardown = installLiveDemoFetchInterceptor({
        onIntercept: (message) => {
          showToast({ kind: "info", title: "Read-only demo", description: message });
        }
      });
      fetchInterceptorTeardownRef.current = teardown;
      return () => {
        teardown();
        fetchInterceptorTeardownRef.current = null;
      };
    }
    if (fetchInterceptorTeardownRef.current) {
      fetchInterceptorTeardownRef.current();
      fetchInterceptorTeardownRef.current = null;
    }
    return undefined;
  }, [active, mode]);

  // --- visible steps in current mode ---------------------------------------
  const visibleSteps = useMemo<DemoStep[]>(() => {
    const m = mode ?? "sandbox";
    return FULL_DEMO_SCRIPT.filter((s) => isStepInMode(s, m));
  }, [mode]);

  const stepIndex = useMemo(() => {
    if (!stepId) return 0;
    const idx = visibleSteps.findIndex((s) => s.id === stepId);
    return idx >= 0 ? idx : 0;
  }, [stepId, visibleSteps]);

  const currentStep: DemoStep | null = active ? visibleSteps[stepIndex] ?? null : null;

  // --- inbox → threadIdMap lookup (sandbox only) ---------------------------
  // Refreshes whenever the walkthrough becomes active, the mode changes, or
  // the operator advances to a step that needs an unresolved platformThreadId.
  // GET only, ignored on failure so a transient runner blip doesn't stall the
  // walkthrough.
  const refreshThreadIdMap = useCallback(async () => {
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      const next = buildThreadIdMap(inbox.rows);
      // Skip the setState when the refetch produced the same map. A new
      // Map reference here would re-run the route-change effect, which
      // refetches again — an unbounded loop when a showcase thread never
      // seeds. Returning the previous reference keeps the effect stable.
      setThreadIdMap((prev) => (threadIdMapsEqual(prev, next) ? prev : next));
    } catch {
      /* leave previous map */
    }
  }, []);
  useEffect(() => {
    // Refresh the map whenever a flow is running against the sandbox.
    // The presenter live flow doesn't need it (real threads), but it's
    // cheap and the sandbox cases are: presenter + sandbox mode, and
    // pilot (which always runs against sandbox).
    if (flow === "pilot" || (flow === "presenter" && mode === "sandbox")) {
      void refreshThreadIdMap();
    }
  }, [flow, mode, refreshThreadIdMap]);

  // --- route-changing on step entry ----------------------------------------
  useEffect(() => {
    if (!active || !currentStep) return;
    let target = currentStep.route;
    if (currentStep.threadPlatformId) {
      const resolved = threadIdMap.get(currentStep.threadPlatformId);
      if (!resolved) {
        // Map not populated yet (race on first sandbox start) or the
        // showcase row has not seeded. Refetch and bail this tick; the
        // next render with the updated map will retry.
        void refreshThreadIdMap();
        return;
      }
      target = `/thread/${resolved}`;
    }
    if (!target) return;
    if (typeof window !== "undefined" && window.location.pathname === target) return;
    router.push(target);
  }, [active, currentStep, router, threadIdMap, refreshThreadIdMap]);

  // --- autoplay timer ------------------------------------------------------
  useEffect(() => {
    if (!active || !autoplay || !currentStep) return undefined;
    const ms = currentStep.waitMs ?? AUTOPLAY_DEFAULT_MS;
    const handle = window.setTimeout(() => {
      const nextStep = visibleSteps[stepIndex + 1];
      if (nextStep) {
        setStepId(nextStep.id);
        writeFullDemoState({ stepId: nextStep.id });
      } else {
        // Pause at the end rather than looping.
        setAutoplayState(false);
        writeFullDemoState({ autoplay: false });
      }
    }, ms);
    return () => window.clearTimeout(handle);
  }, [active, autoplay, currentStep, stepIndex, visibleSteps]);

  // --- public actions ------------------------------------------------------
  const start = useCallback(
    async (newMode: FullDemoMode, threadIds?: string[]) => {
      // Tell the runner. Sandbox flips demoMode=true via the
      // derivedDemoMode in /control/settings; live just sets the read-only
      // flag without touching real data.
      const payload: Partial<AppSettings> = {
        presenterDemoMode: newMode,
        presenterReadOnly: newMode === "live"
      };
      try {
        await apiPost<AppSettings>("/runner/control/settings", payload);
      } catch (err) {
        showToast({
          kind: "error",
          title: "Couldn't start demo",
          description: err instanceof Error ? err.message : "Unknown error"
        });
        return;
      }
      const initialStepId = FULL_DEMO_SCRIPT.find((s) => isStepInMode(s, newMode))?.id ?? "opening";
      setFlow("presenter");
      setMode(newMode);
      setStepId(initialStepId);
      setAutoplayState(false);
      setLiveThreadIds(threadIds ?? []);
      writeFullDemoState({
        active: true,
        mode: newMode,
        stepId: initialStepId,
        autoplay: false,
        liveThreadIds: threadIds ?? []
      });
      await refreshSettings();
      signalInboxResync();
    },
    [refreshSettings]
  );

  const startPilotSandbox = useCallback(async () => {
    // Seed the sandbox without engaging the presenter walkthrough.
    // Pilot tour owns its own GuidedTour overlay against the same
    // showcase data.
    if (flow === "presenter" || flow === "pilot") {
      // A guided flow is already running. The presenter walkthrough owns the
      // overlay, and a pilot tour is already seeded — re-seeding here would
      // re-POST the sandbox for a tour that's already live. Bow out either way.
      return;
    }
    const payload: Partial<AppSettings> = {
      presenterDemoMode: "sandbox",
      presenterReadOnly: false
    };
    try {
      await apiPost<AppSettings>("/runner/control/settings", payload);
    } catch (err) {
      showToast({
        kind: "error",
        title: "Couldn't start demo",
        description: err instanceof Error ? err.message : "Unknown error"
      });
      throw err;
    }
    setFlow("pilot");
    setMode("sandbox");
    setLiveThreadIds([]);
    await refreshSettings();
    signalInboxResync();
  }, [flow, refreshSettings]);

  const goToStepId = useCallback((id: string) => {
    setStepId(id);
    writeFullDemoState({ stepId: id });
  }, []);

  const next = useCallback(() => {
    const idx = visibleSteps.findIndex((s) => s.id === stepId);
    const target = visibleSteps[idx + 1];
    if (!target) {
      // Last step: Done should tear the walkthrough down rather than
      // silently no-op. Mirrors the pilot tour's Done behaviour.
      void exitRef.current?.();
      return;
    }
    setStepId(target.id);
    writeFullDemoState({ stepId: target.id });
  }, [stepId, visibleSteps]);

  const back = useCallback(() => {
    const idx = visibleSteps.findIndex((s) => s.id === stepId);
    const target = visibleSteps[idx - 1];
    if (!target) return;
    setStepId(target.id);
    writeFullDemoState({ stepId: target.id });
  }, [stepId, visibleSteps]);

  const setAutoplay = useCallback((on: boolean) => {
    setAutoplayState(on);
    writeFullDemoState({ autoplay: on });
  }, []);

  const exit = useCallback(async () => {
    const demoNotificationIds = new Set(
      getDemoThreadIds(
        Array.from(threadIdMap, ([platformThreadId, id]) => ({ id, platformThreadId }))
      )
    );
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      for (const row of inbox.rows) {
        if (isDemoThread(row)) demoNotificationIds.add(row.id);
      }
    } catch {
      /* use the last resolved sandbox thread map */
    }
    try {
      await apiPost("/runner/control/presenter-demo/reset", {});
    } catch (err) {
      showToast({
        kind: "error",
        title: "Couldn't end demo cleanly",
        description: err instanceof Error ? err.message : "Try again in Settings."
      });
    }
    setFlow(null);
    setMode(null);
    setStepId(null);
    setAutoplayState(false);
    setLiveThreadIds([]);
    clearFullDemoState();
    dismissCenterNotifications([...demoNotificationIds]);
    await refreshSettings();
    signalInboxResync();
  }, [refreshSettings, threadIdMap]);
  // `next` is declared above `exit` and needs to trigger teardown when
  // pressed on the final step. Keep a ref so that callback can reach the
  // current `exit` without re-creating itself on every render.
  exitRef.current = exit;

  // --- recovery state computation ------------------------------------------
  // Recovery means: server says presenter flags are still on, but no local
  // flow is driving the sandbox. Pilot counts as "driving" — its overlay
  // mounts the same teardown path on exit.
  const recoveryNeeded = flow === null && presenterFlagsOn(serverSettings);

  // The pilot tour and the presenter sandbox run against demo-seeded threads;
  // only then should Today/Inbox hide real threads. Presenter live / read-only
  // mode keeps real threads visible (it demos over the operator's real data).
  const sandboxActive = flow === "pilot" || (flow === "presenter" && mode === "sandbox");

  const value = useMemo<FullDemoContextValue>(
    () => ({
      active,
      flow,
      mode,
      sandboxActive,
      stepIndex,
      visibleStepCount: visibleSteps.length,
      currentStep,
      autoplay,
      serverSettings,
      recoveryNeeded,
      liveThreadIds,
      threadIdMap,
      start,
      startPilotSandbox,
      next,
      back,
      goToStepId,
      setAutoplay,
      exit,
      refreshSettings
    }),
    [
      active,
      flow,
      mode,
      sandboxActive,
      stepIndex,
      visibleSteps.length,
      currentStep,
      autoplay,
      serverSettings,
      recoveryNeeded,
      liveThreadIds,
      threadIdMap,
      start,
      startPilotSandbox,
      next,
      back,
      goToStepId,
      setAutoplay,
      exit,
      refreshSettings
    ]
  );

  return <FullDemoContext.Provider value={value}>{children}</FullDemoContext.Provider>;
}

export function useFullDemo(): FullDemoContextValue {
  const ctx = useContext(FullDemoContext);
  if (!ctx) {
    throw new Error("useFullDemo must be used inside <FullDemoProvider>");
  }
  return ctx;
}
