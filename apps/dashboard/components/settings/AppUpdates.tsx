"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGetRaw, apiPost } from "@/lib/api";
import { APP_NAME, LEGACY_APP_NAME } from "@/lib/branding";
import {
  buildTechnicalDetails,
  describeUpdateState,
  extractBranchRef,
  extractPullRequestRef,
  hostAppTitle,
  hostKindToPlatform,
  hostOfflineCheckMessage,
  installLocationCopy,
  presentReleaseNotes,
  readAppUpdatesSnapshot,
  technicalDetailsOpenByDefault,
  updateRestartNotice,
  writeAppUpdatesSnapshot,
  type AppUpdatesSnapshot,
  type HostDeviceKind,
  type UpdateUiState
} from "@/lib/app-update-presentation";
import {
  hostOfflineExplanation,
  type HostPlatformId
} from "@/lib/host-device";

// Calm "App updates" card for Settings. Updates always apply to the host
// computer running the app (often viewed from a phone on the same Wi-Fi).

interface UpdateCheck {
  applyMode?: "automatic" | "replace_app";
  automaticUpdates: boolean;
  configured: boolean;
  currentVersion: string;
  currentReleaseNotes: string[];
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string[];
  error?: string;
  commit?: string;
  channel?: string;
  build?: string;
  hostDeviceLabel?: string;
  hostDeviceKind?: HostDeviceKind;
}

interface AppVersion {
  version: string;
  releaseNotes?: string[];
  commit?: string;
  channel?: string;
  build?: string;
  hostDeviceLabel?: string;
  hostDeviceKind?: HostDeviceKind;
}

interface StageResponse {
  ok: boolean;
  updating?: boolean;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  message?: string;
}

interface SettingsResponse {
  automaticUpdates: boolean;
}

function snapshotFromState(input: {
  hostLabel: string;
  hostKind: HostDeviceKind;
  info: UpdateCheck | null;
  automaticUpdates: boolean;
  status: UpdateUiState;
  statusMessage: string;
  error: string;
  started: { from: string; to: string; message?: string } | null;
  installHelp: string;
}): AppUpdatesSnapshot {
  return {
    hostLabel: input.hostLabel,
    hostKind: input.hostKind,
    currentVersion: input.info?.currentVersion ?? "",
    latestVersion: input.info?.latestVersion ?? "",
    updateAvailable: Boolean(input.info?.updateAvailable),
    configured: Boolean(input.info?.configured),
    automaticUpdates: input.automaticUpdates,
    applyMode: input.info?.applyMode,
    currentReleaseNotes: input.info?.currentReleaseNotes ?? [],
    releaseNotes: input.info?.releaseNotes ?? [],
    commit: input.info?.commit,
    channel: input.info?.channel,
    build: input.info?.build,
    status: input.status,
    statusMessage: input.statusMessage,
    error: input.error,
    started: input.started,
    installHelp: input.installHelp,
    updatedAt: Date.now()
  };
}

function platformToKind(platform?: HostPlatformId | null): HostDeviceKind | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "pc";
  if (platform === "linux") return "computer";
  return null;
}

export function AppUpdates({
  hostDeviceLabel: hostDeviceLabelProp,
  hostPlatform,
  remoteAvailable = true,
  offlineExplanation
}: {
  /** Phone Settings action label, e.g. "Updates install on your Mac". */
  hostDeviceLabel?: string;
  hostPlatform?: HostPlatformId | null;
  remoteAvailable?: boolean;
  offlineExplanation?: string;
} = {}) {
  const cached = readAppUpdatesSnapshot();
  const [info, setInfo] = useState<UpdateCheck | null>(() =>
    cached
      ? {
          applyMode: cached.applyMode,
          automaticUpdates: cached.automaticUpdates,
          configured: cached.configured,
          currentVersion: cached.currentVersion,
          currentReleaseNotes: cached.currentReleaseNotes,
          latestVersion: cached.latestVersion,
          updateAvailable: cached.updateAvailable,
          releaseNotes: cached.releaseNotes,
          commit: cached.commit,
          channel: cached.channel,
          build: cached.build,
          hostDeviceLabel: cached.hostLabel,
          hostDeviceKind: cached.hostKind
        }
      : null
  );
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [runnerStarting, setRunnerStarting] = useState(false);
  const [runnerOffline, setRunnerOffline] = useState(cached?.status === "host_offline");
  const [started, setStarted] = useState<{ from: string; to: string; message?: string } | null>(
    () => cached?.started ?? null
  );
  const [error, setError] = useState(cached?.error ?? "");
  const [installHelp, setInstallHelp] = useState(cached?.installHelp ?? "");
  const [automaticUpdates, setAutomaticUpdates] = useState(cached?.automaticUpdates ?? true);
  const [savingAutomaticUpdates, setSavingAutomaticUpdates] = useState(false);
  const [automaticUpdatesMsg, setAutomaticUpdatesMsg] = useState("");
  const [hostLabel, setHostLabel] = useState(cached?.hostLabel ?? "your Mac");
  const [hostKind, setHostKind] = useState<HostDeviceKind>(
    cached?.hostKind ?? platformToKind(hostPlatform) ?? "mac"
  );
  const [statusOverride, setStatusOverride] = useState<UpdateUiState | null>(
    cached && (cached.status === "updating" || cached.status === "restart_required")
      ? cached.status
      : null
  );

  const remoteBlocked = remoteAvailable === false;
  const hostOffline = runnerOffline || remoteBlocked;
  const offlineMessage =
    offlineExplanation ||
    hostOfflineCheckMessage(hostKind) ||
    hostOfflineExplanation(hostPlatform ?? hostKindToPlatform(hostKind), APP_NAME);

  const applyHost = useCallback((res: { hostDeviceLabel?: string; hostDeviceKind?: HostDeviceKind }) => {
    if (res.hostDeviceLabel?.trim()) setHostLabel(res.hostDeviceLabel.trim());
    if (res.hostDeviceKind) setHostKind(res.hostDeviceKind);
  }, []);

  useEffect(() => {
    const kind = platformToKind(hostPlatform);
    if (kind) setHostKind(kind);
  }, [hostPlatform]);

  const check = useCallback(async (manual: boolean) => {
    setChecking(true);
    setError("");
    setRunnerOffline(false);
    setStatusOverride(null);
    try {
      const res = await apiGetRaw<UpdateCheck>("/runner/system/update-check");
      const next: UpdateCheck = {
        ...res,
        currentReleaseNotes: Array.isArray(res.currentReleaseNotes) ? res.currentReleaseNotes : [],
        releaseNotes: Array.isArray(res.releaseNotes) ? res.releaseNotes : []
      };
      setInfo(next);
      setAutomaticUpdates(res.automaticUpdates);
      applyHost(res);
      if (res.error) {
        setError("Could not check the update feed. Try again in a moment.");
      }
    } catch {
      try {
        const version = await apiGetRaw<AppVersion>("/runner/system/version");
        setInfo({
          configured: false,
          automaticUpdates,
          currentVersion: version.version,
          currentReleaseNotes: version.releaseNotes ?? [],
          latestVersion: version.version,
          updateAvailable: false,
          releaseNotes: [],
          commit: version.commit,
          channel: version.channel,
          build: version.build,
          hostDeviceLabel: version.hostDeviceLabel,
          hostDeviceKind: version.hostDeviceKind
        });
        applyHost(version);
        setError(`Could not check for updates. Restart ${APP_NAME}, then try again.`);
      } catch {
        setRunnerOffline(true);
        setInfo(null);
        setError(offlineMessage);
      }
    } finally {
      setChecking(false);
    }
  }, [applyHost, automaticUpdates, offlineMessage]);

  useEffect(() => {
    void check(false);
  }, [check]);

  const status: UpdateUiState = useMemo(() => {
    if (statusOverride) return statusOverride;
    if (checking && !info) return "loading";
    if (checking) return "checking";
    if (hostOffline) return "host_offline";
    if (updating) return "updating";
    if (started) return "restart_required";
    if (error && !info?.updateAvailable) return "error";
    if (info?.updateAvailable) return "available";
    if (info && !info.configured) return "not_configured";
    if (info) return "up_to_date";
    return "loading";
  }, [checking, error, hostOffline, info, started, statusOverride, updating]);

  const statusMessage = useMemo(
    () =>
      describeUpdateState({
        state: status,
        latestVersion: info?.latestVersion,
        errorMessage: error
      }),
    [error, info?.latestVersion, status]
  );

  useEffect(() => {
    writeAppUpdatesSnapshot(
      snapshotFromState({
        hostLabel,
        hostKind,
        info,
        automaticUpdates,
        status,
        statusMessage,
        error,
        started,
        installHelp
      })
    );
  }, [
    automaticUpdates,
    error,
    hostKind,
    hostLabel,
    info,
    installHelp,
    started,
    status,
    statusMessage
  ]);

  const prepareUpdate = useCallback(async () => {
    if (hostOffline) {
      setError(offlineMessage);
      return;
    }
    if (info?.applyMode === "replace_app") {
      setInstallHelp(
        `Quit ${APP_NAME}, open the latest DMG, drag ${APP_NAME} into Applications and choose Replace, then reopen it. If an app named ${LEGACY_APP_NAME} is still in Applications, remove it. Your messages and settings are kept.`
      );
      return;
    }
    setUpdating(true);
    setStatusOverride("updating");
    setError("");
    try {
      const res = await apiPost<StageResponse>("/runner/system/update", {});
      if (res.ok) {
        setStarted({
          from: res.fromVersion ?? info?.currentVersion ?? "",
          to: res.toVersion ?? info?.latestVersion ?? "",
          message: res.message
        });
        setStatusOverride("restart_required");
      } else {
        setStatusOverride(null);
        setError(res.message ?? "Could not start the update. Try Check for updates again.");
      }
    } catch (err) {
      setStatusOverride(null);
      const message = err instanceof Error && err.message ? err.message : "";
      setError(message || "Could not start the update. Try again in a moment.");
    } finally {
      setUpdating(false);
    }
  }, [hostOffline, info, offlineMessage]);

  const startRunner = useCallback(async () => {
    setRunnerStarting(true);
    setError("");
    try {
      const response = await fetch("/api/local-runner/start", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.reason ?? `Request failed: ${response.status}`);
      }
      window.setTimeout(() => void check(true), 2500);
      window.setTimeout(() => void check(true), 6000);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "";
      setError(message || `Could not start the runner. Try reopening ${APP_NAME}.`);
    } finally {
      setRunnerStarting(false);
    }
  }, [check]);

  const toggleAutomaticUpdates = useCallback(async () => {
    if (hostOffline) {
      setError(offlineMessage);
      return;
    }
    const next = !automaticUpdates;
    setSavingAutomaticUpdates(true);
    setAutomaticUpdatesMsg("Saving…");
    setError("");
    try {
      const saved = await apiPost<SettingsResponse>("/runner/control/settings", {
        automaticUpdates: next
      });
      setAutomaticUpdates(saved.automaticUpdates);
      setInfo((current) => (current ? { ...current, automaticUpdates: saved.automaticUpdates } : current));
      setAutomaticUpdatesMsg("Saved");
      window.setTimeout(() => setAutomaticUpdatesMsg(""), 1800);
    } catch {
      setAutomaticUpdatesMsg("");
      setError("Could not save automatic update settings. Try again.");
    } finally {
      setSavingAutomaticUpdates(false);
    }
  }, [automaticUpdates, hostOffline, offlineMessage]);

  const version = info?.currentVersion ?? cached?.currentVersion ?? "…";
  const currentNotes = presentReleaseNotes(info?.currentReleaseNotes ?? []);
  const upcomingNotes = presentReleaseNotes(
    info?.updateAvailable ? info.releaseNotes ?? [] : []
  );
  const rawNotes = [
    ...(info?.currentReleaseNotes ?? []),
    ...(info?.updateAvailable ? info.releaseNotes ?? [] : [])
  ];
  const technicalDetails = buildTechnicalDetails({
    commit: info?.commit,
    channel: info?.channel,
    build: info?.build,
    branch: extractBranchRef(rawNotes),
    pullRequest: extractPullRequestRef(rawNotes),
    technicalLines: [
      ...currentNotes.technicalLines,
      ...upcomingNotes.technicalLines
    ].filter((line, index, all) => all.indexOf(line) === index)
  });
  const showTechnical = technicalDetails.length > 0;
  const techOpenDefault = technicalDetailsOpenByDefault(info?.channel);
  const checkDisabled = checking || hostOffline || updating || Boolean(started);
  const title = hostAppTitle(APP_NAME, hostLabel);

  return (
    <div className="rounded-row border border-hairline bg-paper-2 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[14px] font-medium text-ink">{title}</p>
          <p className="text-[13px] text-ink-2">
            Version <span className="font-mono">{version}</span>
          </p>
          {hostDeviceLabelProp ? (
            <p className="text-[12px] text-ink-3">{hostDeviceLabelProp}</p>
          ) : null}
          <p className="text-[12.5px] text-ink-3" aria-live="polite">
            {statusMessage}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void check(true)}
            disabled={checkDisabled}
            title={hostOffline ? offlineMessage : undefined}
            className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper hover:text-ink disabled:opacity-60"
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {runnerOffline && !hostDeviceLabelProp ? (
            <button
              type="button"
              onClick={() => void startRunner()}
              disabled={runnerStarting}
              className="inline-flex items-center rounded-pill border border-hairline-strong px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:bg-paper disabled:opacity-60"
            >
              {runnerStarting ? "Starting runner…" : "Start runner"}
            </button>
          ) : null}
          {info?.updateAvailable && !started ? (
            <button
              type="button"
              onClick={() => void prepareUpdate()}
              disabled={updating || hostOffline}
              title={hostOffline ? offlineMessage : undefined}
              className="inline-flex items-center rounded-pill border border-hairline-strong px-[14px] py-[8px] text-[12.5px] font-medium text-accent-ink transition-colors duration-calm hover:bg-paper disabled:opacity-60"
            >
              {updating
                ? "Updating app…"
                : info.applyMode === "replace_app"
                  ? "Show update steps"
                  : "Update app"}
            </button>
          ) : null}
        </div>
      </div>

      {hostOffline ? (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {offlineMessage}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-5 border-t border-hairline pt-4">
        <div>
          <p className="text-[13px] font-medium text-ink">Automatic updates</p>
          <p className="mt-1 max-w-[58ch] text-[12px] leading-relaxed text-ink-3">
            {installLocationCopy(hostKind)}. {APP_NAME} checks shortly after opening and once an hour.
            When an update is ready, it installs on the host computer and reopens with your messages
            and settings kept.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="min-w-[42px] text-right font-mono text-[11px] text-ink-3" aria-live="polite">
            {automaticUpdatesMsg || (automaticUpdates ? "On" : "Off")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={automaticUpdates}
            aria-label="Automatic updates"
            onClick={() => void toggleAutomaticUpdates()}
            disabled={savingAutomaticUpdates || info?.applyMode === "replace_app" || hostOffline}
            className={`relative h-[20px] w-[36px] shrink-0 rounded-pill transition-colors duration-calm ${
              automaticUpdates ? "bg-accent" : "bg-hairline-strong"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <span
              aria-hidden
              className={`absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm ${
                automaticUpdates ? "translate-x-[18px]" : "translate-x-[2px]"
              }`}
            />
          </button>
        </div>
      </div>

      {currentNotes.userFacing.length || upcomingNotes.userFacing.length ? (
        <div className="mt-4 grid gap-3 border-t border-hairline pt-4 sm:grid-cols-2">
          {currentNotes.userFacing.length ? (
            <div>
              <p className="text-[12px] font-medium text-ink">What&apos;s new</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-2">
                {currentNotes.userFacing.slice(0, 4).map((note, i) => (
                  <li key={`current-${i}`}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {upcomingNotes.userFacing.length ? (
            <div>
              <p className="text-[12px] font-medium text-ink">
                Coming in v{info?.latestVersion}
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-2">
                {upcomingNotes.userFacing.slice(0, 4).map((note, i) => (
                  <li key={`next-${i}`}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {showTechnical ? (
        <details
          className="mt-4 rounded-[10px] border border-hairline bg-paper/40 px-4 py-3"
          open={techOpenDefault ? true : undefined}
        >
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink">
            Technical details
          </summary>
          <dl className="mt-3 space-y-1.5 text-[12px] leading-relaxed text-ink-2">
            {technicalDetails.map((detail, i) => (
              <div key={`${detail.label}-${i}`} className="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-2">
                <dt className="text-ink-3">{detail.label}</dt>
                <dd className="m-0 break-all font-mono text-[11.5px] text-ink-2">{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      {started ? (
        <div className="mt-3 space-y-1.5" aria-live="polite">
          <p className="text-[12px] leading-relaxed text-ink-2">
            {started.message ?? "Update started."} v{started.from} to v{started.to}.
          </p>
          <p className="text-[12px] leading-relaxed text-ink-2">
            {updateRestartNotice(APP_NAME, hostKind)}
          </p>
        </div>
      ) : null}

      {installHelp ? (
        <p className="mt-3 text-[12px] leading-relaxed text-ink-2" aria-live="polite">
          {installHelp}
        </p>
      ) : null}

      {error && !hostOffline ? (
        <p
          className="mt-3 rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-relaxed text-ink-2"
          aria-live="polite"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
