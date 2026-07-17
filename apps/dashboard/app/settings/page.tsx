"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutoScanDisabled } from "@inbox-os/core/autoscan";
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  MessageSquareText,
  MonitorCog,
  Plug,
  Send,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon
} from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { Canvas, PageHead } from "@/components/common/canvas";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { FocusSettingsSection } from "@/components/settings/FocusSettingsSection";
import { CalendarFocusSection } from "@/components/settings/CalendarFocusSection";
import { AppUpdates } from "@/components/settings/AppUpdates";
import { WhatsAppConnect } from "@/components/settings/WhatsAppConnect";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { FullDemoSettingsCard } from "@/components/full-demo/FullDemoSettingsCard";
import { openPilotFeedback, PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import {
  notificationsSupported,
  readNotificationPermission,
  requestNotificationPermission,
  subscribeNotificationPermission
} from "@/lib/notifications";
import {
  classifyNotificationClient,
  digestBackgroundPingHint,
  digestDescription,
  DIGEST_CADENCE_OPTIONS,
  digestFrequencyLabel,
  digestPreviewHint,
  digestPreviewLabel,
  macNotificationsGroupHead,
  macNotificationsGroupSubhead,
  messageNotificationsDescription,
  messageNotificationsDeviceLine,
  messageNotificationsPermissionCaption,
  messageNotificationsTitle,
  phoneNotificationsGroupHead,
  quietHoursDescription,
  quietHoursSwitchLabel,
  readClientHintsFromWindow,
  type NotificationClientKind
} from "@/lib/notifications-settings";
import { localDateString } from "@/lib/overdue-digest";
import { APP_NAME } from "@/lib/branding";
import { interpretReassessAllResult } from "@/lib/reassess-all-result";
import type { MarkAllReassessResponse } from "@/lib/reassess-all-result";
import type {
  OverdueDigestCadence,
  OverdueDigestCandidate,
  OverdueDigestPreview,
  OverdueDigestSettings
} from "@/lib/overdue-digest";
import type { PlatformCard } from "@/lib/types";
import { clearTourSeen, startPilotTour } from "@/lib/pilot-tour";
import {
  DEFAULT_SCAN_INTERVAL,
  readScanInterval,
  SCAN_INTERVAL_OPTIONS,
  scanIntervalCaption,
  writeScanInterval,
  type ScanIntervalId
} from "@/lib/scan-interval";
import {
  DEFAULT_QUIET_HOURS_WINDOW,
  formatQuietHoursRange,
  isQuietHoursEnabled,
  readQuietHoursWindow,
  writeQuietHoursEnabled,
  writeQuietHoursWindow,
  type QuietHoursWindow
} from "@/lib/quiet-hours";
import { cn } from "@/lib/utils";
import { classifyConsumerFailure } from "@/lib/consumer-failure";
import { isIMessageFullDiskAccessProblem } from "@/lib/platform-setup";
import { startSetupWizard } from "@/lib/setup-wizard";
import { OptionalComponents } from "@/components/settings/OptionalComponents";
import {
  applyUiScale,
  onUiScaleChange,
  readUiScale,
  UI_SCALE_OPTIONS,
  type UiScale
} from "@/lib/ui-scale";

const AUTO_SCAN_KEY = "linkedin_dashboard_autoscan_enabled";
const DEFAULT_SETTINGS_TAB: SettingsTabId = "setup";

type SettingsTabId =
  | "setup"
  | "platforms"
  | "capture"
  | "notifications"
  | "writing"
  | "focus"
  | "app"
  | "pilot";

interface SettingsTab {
  id: SettingsTabId;
  label: string;
  description: string;
  icon: LucideIcon;
}

const SETTINGS_TABS: SettingsTab[] = [
  {
    id: "setup",
    label: "Setup",
    description: "Install, contact names, and platform connection steps.",
    icon: CircleHelp
  },
  {
    id: "platforms",
    label: "Platforms",
    description: "Connect messaging and social accounts available on this computer.",
    icon: Plug
  },
  {
    id: "capture",
    label: "Capture",
    description: "Scanning, browser behavior, and platform connection controls.",
    icon: SlidersHorizontal
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Phone alerts, Mac quiet hours, and overdue reply reminders.",
    icon: Bell
  },
  {
    id: "writing",
    label: "Reply style",
    description: "Your voice, AI help level, and reply-support cache controls.",
    icon: MessageSquareText
  },
  {
    id: "focus",
    label: "Focus",
    description: "Focus Reply Buffer defaults and acknowledgement notes.",
    icon: Send
  },
  {
    id: "app",
    label: "App",
    description: "Updates, demo mode, and local app controls.",
    icon: MonitorCog
  },
  {
    id: "pilot",
    label: "Pilot",
    description: "Welcome guide, feedback, bug reports, and walkthrough reset.",
    icon: Sparkles
  }
];


const PLATFORM_DISPLAY: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  IMESSAGE: "iMessage",
  WHATSAPP: "WhatsApp",
  GOOGLE_MESSAGES: "Google Messages"
};

type PlatformActionEndpoint = "open-browser" | "connect" | "scan" | "full-disk-access";

interface FullDiskAccessResponse {
  message?: string;
  runnerProcess?: PlatformCard["runnerProcess"];
}

function isSettingsTabId(value: string): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

function tabFromHash(hash: string): SettingsTabId | null {
  const clean = hash.replace(/^#/, "");
  if (isSettingsTabId(clean)) return clean;
  if (clean === "app-updates") return "app";
  if (clean === "reply-style") return "writing";
  return null;
}

function settingsHashForTab(tab: SettingsTabId): string {
  return tab;
}


// Route scroll owner: mobile #921 scrolls Canvas (data-scroll-owner=canvas)
// while shell <main> is overflow-hidden. Desktop still scrolls <main>.
// Prefer explicit owners; fall back to main for pre-#921 shells.
function getRouteScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>('[data-scroll-owner="canvas"]') ??
    document.querySelector<HTMLElement>('[data-scroll-owner="list"]') ??
    document.querySelector("main")
  );
}

function clearSettingsHashUrl(): string {
  if (typeof window === "undefined") return "/settings";
  const url = new URL(window.location.href);
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

// v1 user surface: auto-scan, quiet hours, headless browser, and the user
// voice / reply-style profile the AI prompts read (UserVoiceProfile). Other
// operator-only knobs (demo data, scan thresholds, AI provider, enabled
// platforms, danger-zone wipe, runner restart) were stripped in PR1;
// restore from archive/pre-v1-stripback if they're needed back.
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(DEFAULT_SETTINGS_TAB);
  // Phone: no category hash means the landing list; a hash opens a subpage.
  // Desktop ignores this and always shows the multi-column layout.
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const listScrollYRef = useRef(0);
  const [autoScan, setAutoScan] = useState(false);
  const [quietHours, setQuietHours] = useState(false);
  const [quietWindow, setQuietWindow] = useState<QuietHoursWindow>(DEFAULT_QUIET_HOURS_WINDOW);
  const [notificationClient, setNotificationClient] = useState<NotificationClientKind>("mac");
  const [autoScanDisabled, setAutoScanDisabled] = useState(false);
  // Pilot R-0087 (#754): the scan cadence is a choice, not a constant.
  const [scanInterval, setScanInterval] = useState<ScanIntervalId>(DEFAULT_SCAN_INTERVAL);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Headless lives in the runner's persisted settings (the runner reads
  // settings.headless when launching Chrome), so unlike autoScan/quietHours
  // it round-trips through the API rather than localStorage.
  const [headless, setHeadless] = useState(true);
  const [headlessReady, setHeadlessReady] = useState(false);
  const [headlessStatus, setHeadlessStatus] = useState<"idle" | "saving" | "error">("idle");

  // Clearing the dismissed flag brings the welcome card back on Today.
  const [welcomeReset, setWelcomeReset] = useState(false);
  const [uiScale, setUiScale] = useState<UiScale>("normal");
  const [platformRows, setPlatformRows] = useState<PlatformCard[]>([]);
  const [platformBusy, setPlatformBusy] = useState<PlatformCard["platform"] | null>(null);
  const [platformError, setPlatformError] = useState("");
  const [platformNotice, setPlatformNotice] = useState("");

  // /settings#app-updates (the update toast / bell entry lands here): scroll
  // the App updates card into view and flash a short highlight ring so the
  // eye finds it. Mount covers cross-page navigation; hashchange/popstate
  // cover in-page jumps and Back.
  const [highlightUpdates, setHighlightUpdates] = useState(false);
  const syncFromLocation = useCallback(() => {
    const tab = tabFromHash(window.location.hash);
    if (tab) {
      setActiveTab(tab);
      setMobileDetailOpen(true);
    } else {
      setMobileDetailOpen(false);
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const onLocation = () => {
      syncFromLocation();
      if (window.location.hash === "#app-updates") {
        window.setTimeout(() => {
          document
            .getElementById("app-updates")
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 0);
        setHighlightUpdates(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setHighlightUpdates(false), 2400);
      }
    };
    onLocation();
    window.addEventListener("hashchange", onLocation);
    window.addEventListener("popstate", onLocation);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", onLocation);
      window.removeEventListener("popstate", onLocation);
    };
  }, [syncFromLocation]);

  // Restore list place on the route scroller (Canvas on mobile #921, main otherwise).
  useEffect(() => {
    const scroller = getRouteScroller();
    if (mobileDetailOpen) {
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    const y = listScrollYRef.current;
    if (y <= 0) return;
    const id = window.requestAnimationFrame(() => {
      const el = getRouteScroller();
      if (el) el.scrollTop = y;
    });
    return () => window.cancelAnimationFrame(id);
  }, [mobileDetailOpen]);

  useEffect(() => {
    setAutoScanDisabled(
      resolveAutoScanDisabled({
        nodeEnv: process.env.NODE_ENV,
        disableAutoScan: process.env.NEXT_PUBLIC_DISABLE_AUTOSCAN,
        legacyDisableAutoScan: process.env.NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN
      })
    );
    setAutoScan(window.localStorage.getItem(AUTO_SCAN_KEY) === "true");
    setScanInterval(readScanInterval());
    setQuietHours(isQuietHoursEnabled());
    setQuietWindow(readQuietHoursWindow());
    setNotificationClient(classifyNotificationClient(readClientHintsFromWindow()));
    setUiScale(readUiScale());
    void apiGet<{ headless?: boolean }>("/runner/data/settings")
      .then((data) => {
        if (data && typeof data.headless === "boolean") setHeadless(data.headless);
        setHeadlessReady(true);
      })
      .catch(() => setHeadlessReady(true));
  }, []);

  const refreshPlatforms = useCallback(async () => {
    const rows = await apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []);
    setPlatformRows(rows ?? []);
  }, []);

  useEffect(() => {
    void refreshPlatforms();
    const onResync = () => void refreshPlatforms();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refreshPlatforms]);

  useEffect(() => onUiScaleChange(() => setUiScale(readUiScale())), []);

  const toggleQuietHours = () => {
    const next = !quietHours;
    setQuietHours(next);
    writeQuietHoursEnabled(next);
    setSavedAt(Date.now());
  };

  const updateQuietWindow = (next: QuietHoursWindow) => {
    const saved = writeQuietHoursWindow(next);
    setQuietWindow(saved);
    setSavedAt(Date.now());
  };

  const toggleAutoScan = () => {
    if (autoScanDisabled) return;
    const next = !autoScan;
    setAutoScan(next);
    window.localStorage.setItem(AUTO_SCAN_KEY, next ? "true" : "false");
    setSavedAt(Date.now());
  };

  const chooseScanInterval = (next: ScanIntervalId) => {
    if (autoScanDisabled) return;
    setScanInterval(next);
    // writeScanInterval also fans out the change event, so the app shell's
    // running scan loop re-arms with the new cadence immediately.
    writeScanInterval(next);
    setSavedAt(Date.now());
  };

  const toggleHeadless = async () => {
    if (!headlessReady || headlessStatus === "saving") return;
    const next = !headless;
    setHeadless(next); // optimistic
    setHeadlessStatus("saving");
    try {
      await apiPost("/runner/control/settings", { headless: next });
      setHeadlessStatus("idle");
      setSavedAt(Date.now());
    } catch {
      setHeadless(!next); // revert
      setHeadlessStatus("error");
    }
  };

  const chooseUiScale = (next: UiScale) => {
    setUiScale(applyUiScale(next));
    setSavedAt(Date.now());
  };

  const platformAction = async (
    platform: PlatformCard["platform"],
    endpoint: PlatformActionEndpoint
  ) => {
    if (platformBusy) return;
    setPlatformBusy(platform);
    setPlatformError("");
    setPlatformNotice("");
    try {
      if (endpoint === "full-disk-access") {
        const result = await apiPost<FullDiskAccessResponse>("/runner/control/imessage/full-disk-access", {});
        const name = result.runnerProcess?.executableName ?? "node";
        const path = result.runnerProcess?.executablePath;
        setPlatformNotice(
          path
            ? `Opened Full Disk Access. Toggle ${name}. macOS may show it as ${name}: ${path}`
            : result.message ?? "Opened Full Disk Access. Toggle the runner app, then restart."
        );
      } else {
        const path =
          endpoint === "scan" ? "/runner/control/scan" : `/runner/control/platform/${endpoint}`;
        await apiPost(path, { platform });
      }
      await refreshPlatforms();
      setSavedAt(Date.now());
    } catch {
      setPlatformError(`Couldn't update ${PLATFORM_DISPLAY[platform]}. Is the runner online?`);
    } finally {
      setPlatformBusy(null);
    }
  };

  const activeTabInfo = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0]!;

  const chooseTab = (tab: SettingsTabId) => {
    setActiveTab(tab);
    setMobileDetailOpen(true);
    const url = new URL(window.location.href);
    url.hash = settingsHashForTab(tab);
    window.history.replaceState(null, "", url);
  };

  const openMobileCategory = (tab: SettingsTabId) => {
    listScrollYRef.current = getRouteScroller()?.scrollTop ?? 0;
    setActiveTab(tab);
    setMobileDetailOpen(true);
    const url = new URL(window.location.href);
    url.hash = settingsHashForTab(tab);
    window.history.pushState({ settingsMobileDetail: true, tab }, "", url);
  };

  const backToSettingsList = () => {
    const state = window.history.state as { settingsMobileDetail?: boolean } | null;
    if (state?.settingsMobileDetail) {
      window.history.back();
      return;
    }
    // Deep links open detail without a settingsMobileDetail marker. Replace the
    // hash entry so system Back leaves Settings instead of reopening the category.
    window.history.replaceState({ settingsList: true }, "", clearSettingsHashUrl());
    setMobileDetailOpen(false);
  };

  return (
    <Canvas className="max-w-[1480px] 3xl:max-w-[1680px]">
      <div className={cn(mobileDetailOpen && "hidden md:block")}>
        <PageHead
          eyebrow="Preferences"
          title="Settings"
          meta={
            savedAt && Date.now() - savedAt < 4000 ? (
              <span className="text-ink">saved</span>
            ) : (
              <span>synced to local profile</span>
            )
          }
        />
      </div>

      {mobileDetailOpen ? (
        <header className="sticky top-0 z-10 -mx-5 mb-5 flex items-center gap-2 bg-[color-mix(in_oklch,var(--paper)_95%,transparent)] px-5 pb-3 pt-3 backdrop-blur-md backdrop-saturate-150 sm:-mx-8 sm:px-8 md:hidden lg:-mx-12 lg:px-12">
          <button
            type="button"
            onClick={backToSettingsList}
            aria-label="Back to Settings"
            className="inline-flex min-h-9 shrink-0 items-center gap-0.5 rounded-[8px] pr-2 text-[15px] font-medium text-ink-2 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
            Settings
          </button>
          <h1 className="m-0 min-w-0 flex-1 truncate text-center font-display text-[17px] font-semibold tracking-[-0.015em] text-ink">
            {activeTabInfo.label}
          </h1>
          <span className="inline-block w-[88px] shrink-0" aria-hidden />
        </header>
      ) : null}

      <div className="grid gap-7 md:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)] md:items-start">
        <div className={cn(mobileDetailOpen && "hidden md:block")}>
          <SettingsTabs
            activeTab={activeTab}
            onChoose={chooseTab}
            onMobileChoose={openMobileCategory}
          />
        </div>
        <section
          aria-label={activeTabInfo.label}
          className={cn("min-w-0", !mobileDetailOpen && "hidden md:block")}
        >
          <div className={cn("mb-7 border-b border-hairline pb-5", mobileDetailOpen && "hidden md:block")}>
            <h2 className="m-0 text-[25px] font-semibold tracking-[-0.015em] text-ink">
              {activeTabInfo.label}
            </h2>
            <p className="m-0 mt-1 max-w-[68ch] text-[13px] leading-[1.5] text-ink-3">
              {activeTabInfo.description}
            </p>
          </div>

          {mobileDetailOpen ? (
            <p className="m-0 mb-6 max-w-[68ch] text-[13px] leading-[1.5] text-ink-3 md:hidden">
              {activeTabInfo.description}
            </p>
          ) : null}

          {activeTab === "setup" ? <SetupGuideSection rows={platformRows} /> : null}

          {activeTab === "platforms" ? (
            <PlatformSettingsSection
              rows={platformRows}
              busy={platformBusy}
              error={platformError}
              notice={platformNotice}
              onAction={platformAction}
            />
          ) : null}

          {activeTab === "capture" ? (
            <>
              <SettingsGroup head="Auto-scan">
                <SettingRow
                  name="Auto-scan"
                  desc="Pull new messages from every connected platform on the cadence you choose below."
                  onActivate={toggleAutoScan}
                  disabled={autoScanDisabled}
                  trailing={
                    <div className="flex items-center gap-[10px]">
                      <span className="font-mono text-[11px] text-ink-3">
                        {autoScanDisabled
                          ? "off (disabled in this build)"
                          : autoScan
                            ? `On · ${scanIntervalCaption(scanInterval)}`
                            : `Off · ${scanIntervalCaption(scanInterval)} when on`}
                      </span>
                      <Toggle
                        on={autoScan && !autoScanDisabled}
                        disabled={autoScanDisabled}
                        onChange={toggleAutoScan}
                        label="Auto-scan"
                      />
                    </div>
                  }
                />
                <SettingRow
                  name="Scan cadence"
                  desc="How often auto-scan checks for new messages. Timing stays slightly randomised around your choice, and quiet hours and active hours still apply. A daily scan runs at the first opportunity after the interval passes."
                  disabled={autoScanDisabled}
                  trailing={
                    <div className="flex flex-wrap items-center justify-end gap-[8px]">
                      {SCAN_INTERVAL_OPTIONS.map((option) => (
                        <CadenceOption
                          key={option.id}
                          label={option.label}
                          selected={scanInterval === option.id}
                          disabled={autoScanDisabled}
                          onClick={() => chooseScanInterval(option.id)}
                        />
                      ))}
                    </div>
                  }
                />
              </SettingsGroup>

              <SettingsGroup head="Browser">
                <SettingRow
                  name="Headless browser"
                  desc="Off by default: the real Chrome runs headful but offscreen, so scans never disrupt you and keep a full human fingerprint. Turn on only for CI or speed. Headless is one of the strongest bot signals and is far more detectable for LinkedIn."
                  onActivate={toggleHeadless}
                  disabled={!headlessReady || headlessStatus === "saving"}
                  trailing={
                    <div className="flex items-center gap-[10px]">
                      <span className="font-mono text-[11px] text-ink-3">
                        {headlessStatus === "saving" ? (
                          "saving…"
                        ) : headlessStatus === "error" ? (
                          <span className="text-risk-overdue">failed</span>
                        ) : headless ? (
                          "On · headless"
                        ) : (
                          "Off · visible"
                        )}
                      </span>
                      <Toggle
                        on={headless}
                        disabled={!headlessReady || headlessStatus === "saving"}
                        onChange={toggleHeadless}
                        label="Headless browser"
                      />
                    </div>
                  }
                />
              </SettingsGroup>
            </>
          ) : null}

          {activeTab === "notifications" ? (
            <NotificationsSettingsPanel
              client={notificationClient}
              quietHours={quietHours}
              quietWindow={quietWindow}
              onToggleQuietHours={toggleQuietHours}
              onQuietWindowChange={updateQuietWindow}
            />
          ) : null}

          {activeTab === "writing" ? (
            <>
              <SettingsGroup head="AI">
                <SettingRow
                  name="Reassess all threads"
                  desc="Clear cached briefs and suggested replies on every active thread so they regenerate against the latest AI prompts. Each thread refreshes lazily when next viewed or scanned. Use after a prompt change ships."
                  trailing={<ReassessAllControl />}
                />
              </SettingsGroup>
              <div data-demo-target="settings-user-voice">
                <UserVoiceProfile variant="settings" className="mt-0" />
              </div>
            </>
          ) : null}

          {activeTab === "focus" ? (
            <>
              <FocusSettingsSection />
              <CalendarFocusSection />
            </>
          ) : null}

          {activeTab === "app" ? (
            <>
              <SettingsGroup head="Display">
                <SettingRow
                  name="Text size"
                  desc="Scale the whole interface on this Mac."
                  trailing={
                    <SegmentedControl
                      options={UI_SCALE_OPTIONS}
                      value={uiScale}
                      onChange={chooseUiScale}
                    />
                  }
                />
              </SettingsGroup>

              <section className="mb-9">
                <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                  Demo
                </p>
                <FullDemoSettingsCard />
              </section>

              <section id="app-updates" className="scroll-mt-24">
                <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                  App updates
                </p>
                <div
                  className={cn(
                    "rounded-row transition-shadow duration-500",
                    highlightUpdates && "ring-2 ring-accent/70"
                  )}
                >
                  <AppUpdates />
                </div>
              </section>
            </>
          ) : null}

          {activeTab === "pilot" ? (
            <section>
              <PilotWelcomeCard />
              <div className="mt-5 flex flex-wrap items-center gap-[10px]">
                <PilotActionButton onClick={() => openPilotFeedback("feedback")}>
                  Share feedback
                </PilotActionButton>
                <PilotActionButton onClick={() => openPilotFeedback("bug")}>
                  Report a bug
                </PilotActionButton>
                <PilotActionButton
                  onClick={() => {
                    window.localStorage.removeItem(PILOT_WELCOME_DISMISSED_KEY);
                    setWelcomeReset(true);
                  }}
                >
                  Show welcome on Today
                </PilotActionButton>
                <PilotActionButton
                  onClick={() => {
                    clearTourSeen(window.localStorage);
                    startPilotTour({ replay: true });
                  }}
                >
                  Replay walkthrough
                </PilotActionButton>
                {welcomeReset ? (
                  <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
                    it’ll show next time you open Today
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
        </section>
      </div>
    </Canvas>
  );
}

function SettingsTabs({
  activeTab,
  onChoose,
  onMobileChoose
}: {
  activeTab: SettingsTabId;
  onChoose: (tab: SettingsTabId) => void;
  onMobileChoose: (tab: SettingsTabId) => void;
}) {
  return (
    <>
      <nav aria-label="Settings sections" className="md:hidden">
        <ul className="m-0 list-none divide-y divide-hairline overflow-hidden rounded-card border border-hairline bg-paper p-0">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => onMobileChoose(tab.id)}
                  className="flex w-full min-w-0 items-center gap-3 px-4 py-[14px] text-left text-ink transition-colors duration-calm hover:bg-paper-2"
                >
                  <Icon
                    className="h-[18px] w-[18px] shrink-0 text-ink-3"
                    strokeWidth={1.8}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[16px] font-medium tracking-[-0.01em]">
                    {tab.label}
                  </span>
                  <ChevronRight
                    className="h-[16px] w-[16px] shrink-0 text-ink-3"
                    strokeWidth={1.8}
                    aria-hidden
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav
        aria-label="Settings sections"
        className="hidden md:sticky md:top-[92px] md:grid md:grid-cols-1 md:gap-2"
      >
        {SETTINGS_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChoose(tab.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-[8px] border px-3 py-[11px] text-left transition-colors duration-calm",
                active
                  ? "border-hairline-strong bg-ink text-paper"
                  : "border-transparent bg-transparent text-ink-2 hover:border-hairline hover:bg-paper-2 hover:text-ink"
              )}
            >
              <Icon
                className={cn("mt-[1px] h-[17px] w-[17px] shrink-0", active ? "text-paper" : "text-ink-3")}
                strokeWidth={1.8}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium">{tab.label}</span>
                <span
                  className={cn(
                    "mt-[3px] block text-[12.5px] leading-[1.35]",
                    active ? "text-paper/70" : "text-ink-3"
                  )}
                >
                  {tab.description}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

function PlatformSettingsSection({
  rows,
  busy,
  error,
  notice,
  onAction
}: {
  rows: PlatformCard[];
  busy: PlatformCard["platform"] | null;
  error: string;
  notice: string;
  onAction: (platform: PlatformCard["platform"], endpoint: PlatformActionEndpoint) => void;
}) {
  const findRow = (platform: PlatformCard["platform"]) =>
    rows.find((row) => row.platform === platform);
  const imessageRow = findRow("IMESSAGE");
  const googleMessagesRow = findRow("GOOGLE_MESSAGES");
  const linkedinRow = findRow("LINKEDIN");
  const whatsappRow = findRow("WHATSAPP");
  const imessageNeedsFullDiskAccess = isIMessageFullDiskAccessProblem(imessageRow);

  return (
    <section className="mb-9">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
        Connected platforms
      </p>
      {error ? <p className="m-0 mb-3 rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-[1.45] text-ink-2">{error}</p> : null}
      {notice ? <p className="m-0 mb-3 font-mono text-[11px] text-risk-fresh">{notice}</p> : null}
      <div className="grid gap-3 xl:grid-cols-2 3xl:grid-cols-3">
        {imessageRow ? (
          <PlatformSetupCard
            row={imessageRow}
            fallbackPlatform="IMESSAGE"
            title="iMessage"
            body="Reads Messages on this Mac. macOS will not show a Full Disk Access pop-up."
            actionLabel={imessageNeedsFullDiskAccess ? "Open Full Disk Access" : "Scan iMessage"}
            busy={busy === "IMESSAGE"}
            onPrimary={() =>
              onAction("IMESSAGE", imessageNeedsFullDiskAccess ? "full-disk-access" : "scan")
            }
          />
        ) : null}
        {googleMessagesRow ? (
          <PlatformSetupCard
            row={googleMessagesRow}
            fallbackPlatform="GOOGLE_MESSAGES"
            title="Google Messages"
            body="Pairs with Google Messages on your Android phone. SMS, MMS, and RCS stay user-triggered."
            actionLabel={googleMessagesRow.status === "CONNECTED" ? "Open Google Messages" : "Pair Android phone"}
            busy={busy === "GOOGLE_MESSAGES"}
            onPrimary={() =>
              onAction(
                "GOOGLE_MESSAGES",
                googleMessagesRow.status === "CONNECTED" ? "open-browser" : "connect"
              )
            }
          />
        ) : null}
        {linkedinRow ? (
          <PlatformSetupCard
            row={linkedinRow}
            fallbackPlatform="LINKEDIN"
            title="LinkedIn"
            body={
              linkedinRow.browserProfileMode === "isolated"
                ? `Uses a dedicated Chrome profile. Sign in when ${APP_NAME} opens it.`
                : "Uses your normal Chrome session. Sign in there first."
            }
            actionLabel={linkedinRow.status === "CONNECTED" ? "Open LinkedIn" : "Connect LinkedIn"}
            busy={busy === "LINKEDIN"}
            onPrimary={() =>
              onAction(
                "LINKEDIN",
                linkedinRow.status === "CONNECTED" ? "open-browser" : "connect"
              )
            }
          />
        ) : null}
        {whatsappRow ? (
          <div className="rounded-[8px] bg-paper-2/45 px-4 py-4">
            <WhatsAppConnect
              scanBusy={busy === "WHATSAPP"}
              onScan={() => onAction("WHATSAPP", "scan")}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PlatformSetupCard({
  row,
  fallbackPlatform,
  title,
  body,
  actionLabel,
  busy,
  onPrimary
}: {
  row?: PlatformCard;
  fallbackPlatform: PlatformCard["platform"];
  title: string;
  body: string;
  actionLabel: string;
  busy: boolean;
  onPrimary: () => void;
}) {
  const status = row?.status ?? "NOT_CONNECTED";
  const connected = status === "CONNECTED";
  const enabled = row?.enabled ?? true;
  const supported = row?.supported !== false;
  const runnerProcess = fallbackPlatform === "IMESSAGE" ? row?.runnerProcess : undefined;
  const platformFailure = row?.lastError
    ? classifyConsumerFailure(new Error(row.lastError), {
        path: "/runner/control/platform/connect",
        method: "POST"
      })
    : null;
  const statusLabel = !supported
    ? "Not available"
    : !enabled
    ? "Off"
    : connected
      ? "Connected"
      : status === "DEGRADED"
        ? "Needs a look"
        : status === "ERROR"
          ? "Error"
          : "Not connected";

  return (
    <article className="rounded-[8px] bg-paper-2/45 px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="m-0 text-[16px] font-semibold text-ink">{title}</h3>
          <p className="m-0 mt-1 text-[13.5px] leading-[1.45] text-ink-3">{body}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-pill px-2 py-[3px] font-mono text-[10.5px]",
            connected ? "bg-risk-fresh/15 text-risk-fresh" : "bg-paper-3 text-ink-3"
          )}
        >
          {statusLabel}
        </span>
      </div>
      {supported && platformFailure ? (
        <p className="m-0 mt-3 rounded-row border border-hairline bg-paper px-3 py-2 text-[12.5px] leading-[1.45] text-ink-2">
          {platformFailure.message} {platformFailure.nextAction}
        </p>
      ) : null}
      {runnerProcess?.executablePath ? (
        <p className="m-0 mt-3 break-all font-mono text-[11px] leading-[1.45] text-ink-3">
          In Full Disk Access, this runner may appear as {runnerProcess.executableName}:{" "}
          {runnerProcess.executablePath}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy || !enabled || !supported}
          className="inline-flex items-center rounded-pill bg-ink px-3 py-[7px] text-[12.5px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Working..." : actionLabel}
        </button>
        {connected ? (
          <span className="font-mono text-[11px] text-ink-3">
            {row?.lastScanAt ? "Scan ready" : PLATFORM_DISPLAY[fallbackPlatform]}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function SetupGuideSection({ rows }: { rows: PlatformCard[] }) {
  const available = new Set(rows.map((row) => row.platform));
  return (
    <section className="mb-9">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[8px] bg-paper-2/45 px-4 py-4">
        <div className="min-w-0">
          <p className="m-0 text-[15.5px] font-medium text-ink">Setup assistant</p>
          <p className="m-0 mt-[3px] text-[13.5px] leading-[1.45] text-ink-3">
            Choose message sources, Contacts, optional AI, voice transcription, and updates, step by step.
          </p>
        </div>
        <button
          type="button"
          onClick={() => startSetupWizard()}
          className="inline-flex items-center rounded-pill bg-ink px-3 py-[7px] text-[12.5px] font-medium text-paper hover:bg-ink-2"
        >
          Run setup assistant
        </button>
      </div>
      <OptionalComponents />
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
        Setup guide
      </p>
      <div className="grid gap-3 xl:grid-cols-2 3xl:grid-cols-3">
        <SetupGuideDrawer
          name="Keep the app running"
          desc="The launcher keeps the app in the background."
          steps={[
            "Start it from Terminal with npm run start:student in the app folder.",
            "Stop it from Terminal with npm run stop:student in the app folder.",
            "If the runner is offline, start it again and reload the browser."
          ]}
          defaultOpen
        />
        {available.has("IMESSAGE") ? (
          <SetupGuideDrawer
            name="iMessage shows phone numbers"
            desc="Sync or import contacts on this Mac."
            steps={[
              "Open Contacts on Mac and check if your people are there.",
              "Best fix: turn on iCloud Contacts on iPhone and Mac.",
              "No iCloud: AirDrop a .vcf file to the Mac, then import it into Contacts.",
              "Run a scan after names appear."
            ]}
          />
        ) : null}
        {available.has("GOOGLE_MESSAGES") ? (
          <SetupGuideDrawer
            name="Connect Google Messages"
            desc="Pair your Android phone from this Windows computer."
            steps={[
              "Open Platforms, then Pair Android phone.",
              "Follow the Google Messages pairing steps in Chrome.",
              "Keep the Chrome window open until the app says connected."
            ]}
          />
        ) : null}
        {available.has("LINKEDIN") ? (
          <SetupGuideDrawer
            name="Connect LinkedIn"
            desc="Use a normal Chrome session. The app never asks for your password."
            steps={[
              "Install Chrome if needed.",
              "Sign into LinkedIn in a normal Chrome window.",
              "Use Connect LinkedIn, complete security checks yourself, then run a scan."
            ]}
          />
        ) : null}
        {available.has("WHATSAPP") ? (
          <SetupGuideDrawer
            name="Connect WhatsApp"
            desc="Link this computer from WhatsApp on your phone."
            steps={[
              "Open Platforms, then Connect WhatsApp.",
              "On your phone, open WhatsApp Settings, Linked Devices, Link a device.",
              "Scan the QR code shown in the app."
            ]}
          />
        ) : null}
        <SetupGuideDrawer
          name="Space and first setup"
          desc="The first install downloads the app, browser, dependencies, and local voice model."
          steps={[
            "You need at least 10GB free. 20GB is more comfortable.",
            "First setup usually takes 20 to 30 minutes.",
            "The health check is npm run doctor from the app folder."
          ]}
        />
      </div>
    </section>
  );
}

function SetupGuideDrawer({
  name,
  desc,
  steps,
  defaultOpen
}: {
  name: string;
  desc: string;
  steps: string[];
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group rounded-[8px] bg-paper-2/45 px-4 py-3 open:bg-paper-2"
      open={defaultOpen}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] items-start gap-4 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-[15.5px] font-medium text-ink">{name}</span>
          <span className="mt-[3px] block text-[13.5px] leading-[1.45] text-ink-3">{desc}</span>
        </span>
        <ChevronDown
          className="mt-[2px] h-[17px] w-[17px] text-ink-3 transition-transform duration-calm group-open:rotate-180"
          strokeWidth={1.8}
          aria-hidden
        />
      </summary>
      <ol className="m-0 mt-4 flex list-decimal flex-col gap-[7px] break-words pl-[18px] text-[13.5px] leading-[1.5] text-ink-2 [overflow-wrap:anywhere]">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </details>
  );
}

// "Reset all threads for reassessment" admin action. Wraps POST to
// /runner/control/threads/mark-all-for-reassess. The endpoint is fast
// (single SQL update) but the action is broad — clears cached AI
// briefs and suggested replies on every active thread — so the click
// goes through a window.confirm gate that names the irreversibility
// and the lazy regen behaviour explicitly. Inline status mirrors the
// headless toggle's pattern so the operator sees running / success /
// error without a toast.
//
// Idle / running / done / error states show inline next to the button.
// The success line names the count concretely ("345 active threads
// reset for reassessment") rather than a vague "done", so the action
// feels grounded.
function ReassessAllControl() {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "intercepted" | "error">("idle");
  const [count, setCount] = useState<number | null>(null);

  const handleClick = async () => {
    if (status === "running") return;
    const ok = window.confirm(
      "Clear cached AI briefs and suggested replies for every active thread? This cannot be undone. Each thread will regenerate lazily as it is next viewed or reassessed."
    );
    if (!ok) return;
    setStatus("running");
    try {
      const result = await apiPost<MarkAllReassessResponse>(
        "/runner/control/threads/mark-all-for-reassess",
        {}
      );
      // In the live presenter demo the fetch interceptor swallows this
      // mutation and resolves with a read-only sentinel that has no
      // `threadsMarked` — fold it into an explicit outcome so we never
      // render "undefined active threads reset for reassessment".
      const outcome = interpretReassessAllResult(result);
      setCount(outcome.count);
      setStatus(outcome.status);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex items-center gap-[10px]">
      {status === "done" && count !== null ? (
        <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
          {count} active threads reset for reassessment
        </span>
      ) : status === "intercepted" ? (
        <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
          read-only demo, nothing changed
        </span>
      ) : status === "error" ? (
        <span className="text-[11px] text-ink-2" aria-live="polite">
          Couldn’t reset. Try again.
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "running"}
        className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "running" ? "Resetting…" : "Reset all for reassessment"}
      </button>
    </div>
  );
}

function PilotActionButton({
  onClick,
  children
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
    >
      {children}
    </button>
  );
}

function SettingsGroup({ head, children }: { head: string; children: React.ReactNode }) {
  return (
    <section className="mb-9">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{head}</p>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SettingRow({
  name,
  desc,
  trailing,
  onActivate,
  disabled
}: {
  name: string;
  desc?: string;
  trailing: React.ReactNode;
  /**
   * Issue #394. When set, the entire row is clickable — not just the
   * tiny switch in the trailing area. Pilot R-0034 read the toggle
   * as "broken" partly because the click target was too small and the
   * row had no obvious affordance. Passing onActivate makes the row
   * a button-like target while still routing the same action.
   *
   * The trailing element (typically <Toggle>) stops propagation on
   * its own onClick so a click on the switch itself doesn't double-fire.
   */
  onActivate?: () => void;
  /** Disables the row click target without changing the trailing visual. */
  disabled?: boolean;
}) {
  const interactive = onActivate && !disabled;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate?.();
              }
            }
          : undefined
      }
      className={cn(
        // Phone: control drops under the description (the trailing column
        // otherwise squeezes the copy to a word per line); sm+ keeps the
        // two-column row.
        "grid grid-cols-1 gap-3 rounded-[8px] px-1 py-[15px] sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6",
        interactive
          ? "cursor-pointer rounded-[6px] transition-colors duration-calm hover:bg-paper-2/60 focus:bg-paper-2/60 focus:outline-none"
          : null
      )}
    >
      <div>
        <p className="m-0 mb-[4px] text-[16px] font-medium text-ink">{name}</p>
        {desc ? (
          <p className="m-0 max-w-[58ch] text-[13.5px] leading-[1.5] text-ink-3" style={{ textWrap: "pretty" }}>
            {desc}
          </p>
        ) : null}
      </div>
      <div onClick={(event) => event.stopPropagation()}>{trailing}</div>
    </div>
  );
}

// #907: Notifications settings split phone vs Mac behaviour, mobile switch
// rows with title-aligned toggles, editable quiet hours, and a non-
// interactive digest preview (no repeated snooze links).
function NotificationsSettingsPanel({
  client,
  quietHours,
  quietWindow,
  onToggleQuietHours,
  onQuietWindowChange
}: {
  client: NotificationClientKind;
  quietHours: boolean;
  quietWindow: QuietHoursWindow;
  onToggleQuietHours: () => void;
  onQuietWindowChange: (next: QuietHoursWindow) => void;
}) {
  return (
    <div data-testid="notifications-settings">
      <SettingsGroup head={phoneNotificationsGroupHead(client)}>
        <MessageNotificationsRow client={client} />
      </SettingsGroup>

      <SettingsGroup head={macNotificationsGroupHead()}>
        <p className="m-0 mb-2 px-1 text-[12.5px] leading-[1.45] text-ink-3">
          {macNotificationsGroupSubhead()}
        </p>
        <MobileSwitchRow
          name={quietHoursSwitchLabel()}
          detail={formatQuietHoursRange(quietWindow)}
          desc={quietHoursDescription()}
          on={quietHours}
          onToggle={onToggleQuietHours}
          testId="quiet-hours-row"
        />
        <QuietHoursTimeEditors
          quietWindow={quietWindow}
          onChange={onQuietWindowChange}
        />
      </SettingsGroup>

      <SettingsGroup head="Overdue reply digest">
        <OverdueDigestRow client={client} />
      </SettingsGroup>
    </div>
  );
}

// Switch sits beside the title with a full-row touch target (min 44px).
function MobileSwitchRow({
  name,
  detail,
  desc,
  on,
  onToggle,
  disabled,
  testId,
  switchLabel
}: {
  name: string;
  detail?: string;
  desc?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  testId?: string;
  switchLabel?: string;
}) {
  const interactive = !disabled;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-testid={testId}
      onClick={interactive ? onToggle : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onToggle();
              }
            }
          : undefined
      }
      className={cn(
        "min-h-[44px] rounded-[8px] px-1 py-[12px]",
        interactive
          ? "cursor-pointer transition-colors duration-calm hover:bg-paper-2/60 focus:bg-paper-2/60 focus:outline-none"
          : "cursor-default"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[16px] font-medium text-ink">{name}</p>
          {detail ? (
            <p className="m-0 mt-[2px] font-mono text-[12px] text-ink-2">{detail}</p>
          ) : null}
          {desc ? (
            <p
              className="m-0 mt-[4px] max-w-[58ch] text-[13.5px] leading-[1.5] text-ink-3"
              style={{ textWrap: "pretty" }}
            >
              {desc}
            </p>
          ) : null}
        </div>
        <div
          className="flex min-h-[44px] shrink-0 items-center"
          onClick={(event) => event.stopPropagation()}
        >
          <Toggle
            on={on}
            disabled={disabled}
            onChange={onToggle}
            label={switchLabel ?? name}
          />
        </div>
      </div>
    </div>
  );
}

function QuietHoursTimeEditors({
  quietWindow,
  onChange
}: {
  quietWindow: QuietHoursWindow;
  onChange: (next: QuietHoursWindow) => void;
}) {
  return (
    <div
      data-testid="quiet-hours-time-editors"
      className="mt-1 grid grid-cols-2 gap-3 rounded-[10px] border border-hairline bg-paper-2/40 px-3 py-3"
    >
      <label className="flex min-h-[44px] flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">From</span>
        <input
          type="time"
          value={quietWindow.start}
          onChange={(event) => onChange({ ...quietWindow, start: event.target.value })}
          className="min-h-[40px] rounded-[8px] border border-hairline bg-paper px-2 font-mono text-[14px] text-ink focus:border-hairline-strong focus:outline-none"
          aria-label="Quiet hours start time"
        />
      </label>
      <label className="flex min-h-[44px] flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">To</span>
        <input
          type="time"
          value={quietWindow.end}
          onChange={(event) => onChange({ ...quietWindow, end: event.target.value })}
          className="min-h-[40px] rounded-[8px] border border-hairline bg-paper px-2 font-mono text-[14px] text-ink focus:border-hairline-strong focus:outline-none"
          aria-label="Quiet hours end time"
        />
      </label>
      <p className="col-span-2 m-0 text-[12px] leading-[1.45] text-ink-3">
        Local time. Auto-scan on the Mac pauses inside this window when quiet hours is on.
      </p>
    </div>
  );
}

// #359: permission ask stays behind an explicit gesture. Caption is
// device-appropriate (#907) instead of always saying "browser".
function MessageNotificationsRow({ client }: { client: NotificationClientKind }) {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notificationsSupported()) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
    return subscribeNotificationPermission(setPermission);
  }, []);

  const enable = async () => {
    if (busy) return;
    if (permission !== "default") return;
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
    } finally {
      setBusy(false);
    }
  };

  const on = permission === "granted";
  const canRequest = permission === "default" && !busy;
  const caption = messageNotificationsPermissionCaption(permission, client, busy);

  return (
    <div data-testid="message-notifications-row">
      <MobileSwitchRow
        name={messageNotificationsTitle(client)}
        detail={messageNotificationsDeviceLine(client)}
        desc={messageNotificationsDescription(client)}
        on={on}
        disabled={!canRequest}
        onToggle={() => {
          if (canRequest) void enable();
        }}
        switchLabel={messageNotificationsTitle(client)}
        testId="message-notifications-switch-row"
      />
      <p className="m-0 px-1 pb-2 font-mono text-[11px] text-ink-3" data-testid="message-notifications-caption">
        {caption}
      </p>
    </div>
  );
}

// #360: calm overdue-reply digest. Cadence is always available; the optional
// OS ping is device-labelled. Settings preview is non-interactive (#907).
function OverdueDigestRow({ client }: { client: NotificationClientKind }) {
  const [settings, setSettings] = useState<OverdueDigestSettings | null>(null);
  const [candidates, setCandidates] = useState<OverdueDigestCandidate[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported"
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");

  const refresh = useCallback(async () => {
    const preview = await apiGet<OverdueDigestPreview>(
      "/runner/data/overdue-digest/preview"
    ).catch(() => null);
    if (!preview) return;
    setSettings(preview.settings);
    setCandidates(preview.candidates);
  }, []);

  useEffect(() => {
    setPermission(readNotificationPermission());
    const unsubscribe = subscribeNotificationPermission(setPermission);
    void refresh();
    return unsubscribe;
  }, [refresh]);

  const writeCadence = async (cadence: OverdueDigestCadence) => {
    if (busy) return;
    setBusy(true);
    setStatus("idle");
    try {
      const next = await apiPost<OverdueDigestSettings>(
        "/runner/control/overdue-digest/settings",
        { cadence }
      );
      setSettings(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const dismissToday = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await apiPost<OverdueDigestSettings>(
        "/runner/control/overdue-digest/dismiss-today",
        { localDate: localDateString() }
      );
      setSettings(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const cadence = settings?.cadence ?? "off";
  const localDateToday = localDateString();
  const alreadyDismissedToday = settings?.dismissForLocalDate === localDateToday;
  const notificationsNotEnabled = permission !== "granted";

  return (
    <div className="rounded-[8px] px-1 py-[12px]" data-testid="overdue-digest-row">
      <p className="m-0 mb-[4px] text-[16px] font-medium text-ink">Overdue reply digest</p>
      <p
        className="m-0 max-w-[58ch] text-[13.5px] leading-[1.5] text-ink-3"
        style={{ textWrap: "pretty" }}
      >
        {digestDescription()}
      </p>
      {notificationsNotEnabled ? (
        <p className="m-0 mt-[8px] font-mono text-[11px] text-ink-3">
          {digestBackgroundPingHint(client)}
        </p>
      ) : null}

      <div className="mt-[14px]">
        <p className="m-0 mb-[8px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          {digestFrequencyLabel()}
        </p>
        <div
          className="flex flex-wrap items-center gap-[8px]"
          role="group"
          aria-label={digestFrequencyLabel()}
          data-testid="digest-cadence-group"
        >
          {DIGEST_CADENCE_OPTIONS.map((option) => (
            <CadenceOption
              key={option.id}
              label={option.label}
              selected={cadence === option.id}
              disabled={busy}
              onClick={() => void writeCadence(option.id)}
            />
          ))}
          {status === "saved" ? (
            <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
              saved
            </span>
          ) : status === "error" ? (
            <span className="text-[11px] text-ink-2" aria-live="polite">
              Couldn&apos;t save. Try again.
            </span>
          ) : null}
        </div>
      </div>

      {cadence !== "off" ? (
        <div
          className="mt-[16px] rounded-[10px] border border-hairline bg-paper-2/40 p-[12px]"
          data-testid="digest-preview"
        >
          <p className="m-0 mb-[4px] font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            {digestPreviewLabel()}
          </p>
          <p className="m-0 mb-[10px] text-[12px] leading-[1.45] text-ink-3">
            {digestPreviewHint()}
          </p>
          {candidates.length === 0 ? (
            <p className="m-0 text-[12.5px] text-ink-3">Nothing waiting on you right now.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[8px] p-0" aria-label="Digest preview">
              {candidates.map((c) => (
                <li
                  key={`${c.threadId}:${c.personId}`}
                  className="flex min-h-[36px] items-center gap-[10px] text-[13px] text-ink-2"
                >
                  <span
                    className={cn(
                      "inline-block h-[6px] w-[6px] shrink-0 rounded-full",
                      c.riskLevel === "RED" ? "bg-risk-overdue" : "bg-risk-waiting"
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{c.personName}</span>
                </li>
              ))}
            </ul>
          )}
          {candidates.length > 0 ? (
            <div className="mt-[12px]">
              <button
                type="button"
                onClick={() => void dismissToday()}
                disabled={busy || alreadyDismissedToday}
                className={cn(
                  "inline-flex min-h-[44px] items-center rounded-pill border border-hairline px-[14px] py-[8px] font-mono text-[12px] text-ink-2 transition-colors duration-calm",
                  "hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
                  (busy || alreadyDismissedToday) && "cursor-not-allowed opacity-60"
                )}
              >
                {alreadyDismissedToday ? "Dismissed for today" : "Dismiss for today"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CadenceOption({
  label,
  selected,
  disabled,
  disabledReason,
  onClick
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={disabled && disabledReason ? disabledReason : undefined}
      className={cn(
        "inline-flex min-h-[44px] items-center rounded-pill border px-[16px] py-[8px] font-mono text-[12px] transition-colors duration-calm",
        selected
          ? "border-ink bg-ink text-paper"
          : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      {label}
      {disabled && disabledReason ? (
        <span className="ml-1 text-ink-3">({disabledReason})</span>
      ) : null}
    </button>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-pill bg-paper-2 p-[3px]">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
            className={cn(
              "rounded-pill px-3 py-[6px] text-[12.5px] font-medium transition-colors duration-calm",
              selected ? "bg-ink text-paper" : "text-ink-3 hover:text-ink"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  disabled,
  label
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        // shrink-0 so the surrounding flex row (state caption + pill)
        // can't compress the track below 36px — when it did, the 16px
        // knob's on/off offsets collapsed and the switch read as
        // reversed/ambiguous (#429 R-0052).
        "relative h-[20px] w-[36px] shrink-0 rounded-pill transition-colors duration-calm",
        // Accent fill ON vs neutral track OFF reads clearly in BOTH
        // light and dark mode. The old bg-ink/bg-hairline pair was two
        // near-identical darks in dark mode, so the states were
        // indistinguishable without reading the label (#429 R-0052).
        on ? "bg-accent" : "bg-hairline-strong",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <span
        aria-hidden
        className={cn(
          // Fixed white knob (not theme paper) so it contrasts on the
          // grey OFF track and the accent ON track in either mode. OFF =
          // left, ON = right per platform convention.
          //
          // left-0 anchors the knob to the track's left edge. Without it
          // the absolute knob's static position resolved to the RIGHT
          // (computed left:18px), so the off-state translate-x-[2px] put
          // the knob at ~20px — i.e. the switch read reversed: off showed
          // the knob on the right (#429 R-0052). The transform classes
          // were always correct; the missing anchor was the real bug.
          "absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm",
          on ? "translate-x-[18px]" : "translate-x-[2px]"
        )}
      />
    </button>
  );
}
