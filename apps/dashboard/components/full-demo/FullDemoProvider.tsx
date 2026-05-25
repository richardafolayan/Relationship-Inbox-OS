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
import { clearFullDemoState, readFullDemoState, writeFullDemoState } from "@/lib/full-demo-state";
import { installLiveDemoFetchInterceptor } from "@/lib/full-demo-fetch";

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

interface FullDemoContextValue {
  /** Local "the walkthrough is currently active" — set while the controller is running. */
  active: boolean;
  /** Walkthrough mode if active, otherwise null. */
  mode: FullDemoMode | null;
  /** Index into FULL_DEMO_SCRIPT, filtered to steps in the current mode. */
  stepIndex: number;
  /** Total visible steps in the current mode. */
  visibleStepCount: number;
  /** Current DemoStep if active, otherwise null. */
  currentStep: DemoStep | null;
  autoplay: boolean;
  /** Server settings as last fetched — used by banner + recovery surfaces. */
  serverSettings: AppSettings | null;
  /**
   * True when the server reports presenter on (presenterDemoMode !== "off"
   * OR presenterReadOnly === true) but local state has no active flag.
   * Banner / Settings shell uses this to offer a "Recover demo state"
   * one-click exit.
   */
  recoveryNeeded: boolean;
  liveThreadIds: string[];

  start: (mode: FullDemoMode, liveThreadIds?: string[]) => Promise<void>;
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

export function FullDemoProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<FullDemoMode | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [autoplay, setAutoplayState] = useState(false);
  const [serverSettings, setServerSettings] = useState<AppSettings | null>(null);
  const [liveThreadIds, setLiveThreadIds] = useState<string[]>([]);
  const fetchInterceptorTeardownRef = useRef<(() => void) | null>(null);
  // platformThreadId → internal thread id, populated from /data/inbox
  // when sandbox is active. The script references threads by their stable
  // platformThreadId; the dashboard /thread/[id] route wants the runner's
  // cuid. This map bridges the two without baking cuids into the script.
  const [threadIdMap, setThreadIdMap] = useState<Map<string, string>>(new Map());

  // --- localStorage hydration on mount -------------------------------------
  useEffect(() => {
    const initial = readFullDemoState();
    if (initial.active) {
      setActive(true);
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
      const next = new Map<string, string>();
      for (const row of inbox.rows ?? []) {
        if (row.platformThreadId) next.set(row.platformThreadId, row.id);
      }
      setThreadIdMap(next);
    } catch {
      /* leave previous map */
    }
  }, []);
  useEffect(() => {
    if (active && mode === "sandbox") void refreshThreadIdMap();
  }, [active, mode, refreshThreadIdMap]);

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
      setActive(true);
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
    },
    [refreshSettings]
  );

  const goToStepId = useCallback((id: string) => {
    setStepId(id);
    writeFullDemoState({ stepId: id });
  }, []);

  const next = useCallback(() => {
    const idx = visibleSteps.findIndex((s) => s.id === stepId);
    const target = visibleSteps[idx + 1];
    if (!target) return;
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
    try {
      await apiPost("/runner/control/presenter-demo/reset", {});
    } catch (err) {
      showToast({
        kind: "error",
        title: "Couldn't end demo cleanly",
        description: err instanceof Error ? err.message : "Try again in Settings."
      });
    }
    setActive(false);
    setMode(null);
    setStepId(null);
    setAutoplayState(false);
    setLiveThreadIds([]);
    clearFullDemoState();
    await refreshSettings();
  }, [refreshSettings]);

  // --- recovery state computation ------------------------------------------
  const recoveryNeeded = !active && presenterFlagsOn(serverSettings);

  const value = useMemo<FullDemoContextValue>(
    () => ({
      active,
      mode,
      stepIndex,
      visibleStepCount: visibleSteps.length,
      currentStep,
      autoplay,
      serverSettings,
      recoveryNeeded,
      liveThreadIds,
      start,
      next,
      back,
      goToStepId,
      setAutoplay,
      exit,
      refreshSettings
    }),
    [
      active,
      mode,
      stepIndex,
      visibleSteps.length,
      currentStep,
      autoplay,
      serverSettings,
      recoveryNeeded,
      liveThreadIds,
      start,
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
