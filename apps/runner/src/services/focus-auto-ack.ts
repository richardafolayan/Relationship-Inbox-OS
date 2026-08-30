import type { PlatformName } from "@inbox-os/core";
import { v5 as uuidv5 } from "uuid";
import type { EventBus, OperatorProfile } from "../types/runtime";
import type { SendQueueService } from "./send-queue";

export interface FocusAutoAckThread {
  threadId: string;
  platform: PlatformName;
  isGroup: boolean;
  category: "outreach" | "genuine" | null;
  person: {
    id: string;
    displayName: string;
    birthday: string | null;
    favouritedAt: Date | null;
  };
  latestInboundAt: Date | null;
  latestOutboundAt: Date | null;
}

interface FocusAutoAckDeps {
  settingsStore: {
    getOperatorProfile(): Promise<OperatorProfile>;
    acknowledgeFocusWindowPerson(windowId: string, personId: string): Promise<boolean>;
  };
  sendQueue: Pick<SendQueueService, "enqueueAndKick">;
  loadThread(threadId: string): Promise<FocusAutoAckThread | null>;
  loadSendRequest(clientSendId: string): Promise<{
    threadId: string;
    source: string;
    status: string;
  } | null>;
  now?: () => Date;
  auditLog?: (input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
  }) => Promise<unknown>;
}

export type FocusAutoAckResult =
  | { type: "queued"; personId: string; clientSendId: string }
  | { type: "skipped"; reason: string };

function looksLikePhoneOrEmail(value: string): boolean {
  const name = value.trim();
  if (!name || name.includes("@")) return true;
  const digits = (name.match(/\d/g) ?? []).length;
  return /^[+()\d\s.\-]+$/.test(name) && digits >= 5;
}

function firstName(value: string): string {
  const name = value.trim();
  if (!name || looksLikePhoneOrEmail(name)) return name || "there";
  return name.split(/\s+/)[0] || name;
}

function formatUntil(endsAt: string): string {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return "later";
  let hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `${hour}:${minute}${meridiem}`;
}

function fillNote(
  template: string,
  input: { name: string; until: string; reason: string }
): string {
  return template
    .replace(/\[Name\]/g, input.name || "there")
    .replace(/\[until\]/g, input.until || "later")
    .replace(/\[reason\]/g, input.reason || "")
    .trim();
}

export function focusAutoAckCoverage(
  thread: FocusAutoAckThread,
  profile: OperatorProfile
): boolean {
  if (
    thread.platform === "INSTAGRAM" ||
    thread.isGroup ||
    thread.category !== "genuine"
  ) {
    return false;
  }
  if (thread.person.favouritedAt) return true;
  if (profile.focusWindow.audience !== "all_personal" || thread.platform !== "IMESSAGE") {
    return false;
  }
  return !looksLikePhoneOrEmail(thread.person.displayName) || Boolean(thread.person.birthday);
}

export function focusAutoAckText(
  thread: FocusAutoAckThread,
  profile: OperatorProfile
): string {
  const professional = thread.platform === "LINKEDIN";
  const template = professional
    ? profile.focusWindow.professionalNote.trim() || profile.ackTemplates.professional
    : profile.focusWindow.note.trim() || profile.ackTemplates.close;
  return fillNote(template, {
    name: firstName(thread.person.displayName),
    until: formatUntil(profile.focusWindow.endsAt),
    reason: profile.focusSettings.reasonLabel ? profile.focusWindow.reason : ""
  });
}

function isLiveAutoWindow(profile: OperatorProfile, now: Date): boolean {
  const window = profile.focusWindow;
  if (!window.active || !window.autoSendAcknowledgements || !window.windowId) return false;
  const startedAt = Date.parse(window.startedAt);
  const endsAt = Date.parse(window.endsAt);
  return Number.isFinite(startedAt) && Number.isFinite(endsAt) && endsAt > now.getTime();
}

function isLiveFocusWindow(profile: OperatorProfile, now: Date): boolean {
  const window = profile.focusWindow;
  if (!window.active || !window.windowId) return false;
  const startedAt = Date.parse(window.startedAt);
  const endsAt = Date.parse(window.endsAt);
  return Number.isFinite(startedAt) && Number.isFinite(endsAt) && endsAt > now.getTime();
}

export function focusAutoAckClientSendId(
  windowId: string,
  personId: string
): string {
  return uuidv5(`${windowId}:${personId}`, uuidv5.URL);
}

export function focusManualAckClientSendId(
  windowId: string,
  personId: string
): string {
  return uuidv5(`manual:${windowId}:${personId}`, uuidv5.URL);
}

export function focusAcknowledgementClientSendIds(
  windowId: string,
  personId: string
): [string, string] {
  return [
    focusManualAckClientSendId(windowId, personId),
    focusAutoAckClientSendId(windowId, personId)
  ];
}

export function focusAutoAckDispatchEligible(
  thread: FocusAutoAckThread,
  profile: OperatorProfile,
  clientSendId: string,
  now: Date,
  queuedText?: string
): boolean {
  if (!isLiveAutoWindow(profile, now) || !focusAutoAckCoverage(thread, profile)) {
    return false;
  }
  if (profile.focusWindow.ackedPersonIds.includes(thread.person.id)) return false;
  if (!thread.latestInboundAt) return false;
  const startedAt = Date.parse(profile.focusWindow.startedAt);
  if (!Number.isFinite(startedAt) || thread.latestInboundAt.getTime() < startedAt) {
    return false;
  }
  if (
    thread.latestOutboundAt &&
    thread.latestOutboundAt.getTime() >= thread.latestInboundAt.getTime()
  ) {
    return false;
  }
  const identityMatches = (
    clientSendId ===
    focusAutoAckClientSendId(profile.focusWindow.windowId, thread.person.id)
  );
  return identityMatches && (
    queuedText === undefined || focusAutoAckText(thread, profile) === queuedText
  );
}

export function focusManualAckDispatchEligible(
  thread: FocusAutoAckThread,
  profile: OperatorProfile,
  clientSendId: string,
  now: Date
): boolean {
  if (!isLiveFocusWindow(profile, now) || !focusAutoAckCoverage(thread, profile)) {
    return false;
  }
  if (profile.focusWindow.ackedPersonIds.includes(thread.person.id)) return false;
  if (!thread.latestInboundAt) return false;
  const startedAt = Date.parse(profile.focusWindow.startedAt);
  if (!Number.isFinite(startedAt) || thread.latestInboundAt.getTime() < startedAt) {
    return false;
  }
  if (
    thread.latestOutboundAt &&
    thread.latestOutboundAt.getTime() >= thread.latestInboundAt.getTime()
  ) {
    return false;
  }
  return (
    clientSendId ===
    focusManualAckClientSendId(profile.focusWindow.windowId, thread.person.id)
  );
}

export function createFocusAutoAckService(deps: FocusAutoAckDeps) {
  const inFlight = new Set<string>();

  async function handleThread(threadId: string): Promise<FocusAutoAckResult> {
    const profile = await deps.settingsStore.getOperatorProfile();
    const thread = await deps.loadThread(threadId);
    if (!thread) return { type: "skipped", reason: "thread_not_found" };
    const personId = thread.person.id;
    if (profile.focusWindow.ackedPersonIds.includes(personId)) {
      return { type: "skipped", reason: "already_acknowledged" };
    }

    if (profile.focusWindow.windowId) {
      const deliveredIds = focusAcknowledgementClientSendIds(
        profile.focusWindow.windowId,
        personId
      );
      for (const deliveredClientSendId of deliveredIds) {
        const delivered = await deps.loadSendRequest(deliveredClientSendId);
        if (
          delivered?.threadId === threadId &&
          (delivered.source === "focus_ack" || delivered.source === "focus_auto_ack") &&
          delivered.status === "SENT"
        ) {
          await deps.settingsStore.acknowledgeFocusWindowPerson(
            profile.focusWindow.windowId,
            personId
          );
          return { type: "skipped", reason: "already_acknowledged" };
        }
      }
    }

    const now = deps.now?.() ?? new Date();
    if (!isLiveAutoWindow(profile, now)) return { type: "skipped", reason: "disabled" };
    if (!focusAutoAckCoverage(thread, profile)) return { type: "skipped", reason: "not_covered" };
    if (!thread.latestInboundAt) return { type: "skipped", reason: "no_inbound" };

    const startedAt = Date.parse(profile.focusWindow.startedAt);
    if (thread.latestInboundAt.getTime() < startedAt) {
      return { type: "skipped", reason: "before_window" };
    }
    if (
      thread.latestOutboundAt &&
      thread.latestOutboundAt.getTime() >= thread.latestInboundAt.getTime()
    ) {
      return { type: "skipped", reason: "already_replied" };
    }
    const key = `${profile.focusWindow.windowId}:${personId}`;
    if (inFlight.has(key)) return { type: "skipped", reason: "in_flight" };
    inFlight.add(key);
    try {
      const latest = await deps.settingsStore.getOperatorProfile();
      if (
        !isLiveAutoWindow(latest, deps.now?.() ?? new Date()) ||
        latest.focusWindow.windowId !== profile.focusWindow.windowId ||
        latest.focusWindow.ackedPersonIds.includes(personId)
      ) {
        return { type: "skipped", reason: "window_changed" };
      }

      const authoritativeThread = await deps.loadThread(threadId);
      if (!authoritativeThread || authoritativeThread.person.id !== personId) {
        return { type: "skipped", reason: "thread_changed" };
      }
      if (!focusAutoAckCoverage(authoritativeThread, latest)) {
        return { type: "skipped", reason: "not_covered" };
      }
      if (!authoritativeThread.latestInboundAt) {
        return { type: "skipped", reason: "no_inbound" };
      }
      if (authoritativeThread.latestInboundAt.getTime() < Date.parse(latest.focusWindow.startedAt)) {
        return { type: "skipped", reason: "before_window" };
      }
      if (
        authoritativeThread.latestOutboundAt &&
        authoritativeThread.latestOutboundAt.getTime() >=
          authoritativeThread.latestInboundAt.getTime()
      ) {
        return { type: "skipped", reason: "already_replied" };
      }

      const text = focusAutoAckText(authoritativeThread, latest);
      if (!text) return { type: "skipped", reason: "empty_note" };
      const clientSendId = focusAutoAckClientSendId(
        latest.focusWindow.windowId,
        personId
      );
      const enqueueResult = await deps.sendQueue.enqueueAndKick({
        threadId,
        text,
        clientSendId,
        source: "focus_auto_ack",
        focusWindowId: latest.focusWindow.windowId
      });

      if (enqueueResult.status === "FAILED") {
        throw new Error(enqueueResult.errorMessage ?? "Automatic focus acknowledgement failed");
      }
      if (enqueueResult.status === "SENT") {
        await deps.settingsStore.acknowledgeFocusWindowPerson(
          latest.focusWindow.windowId,
          personId
        );
      }
      await deps.auditLog?.({
        platform: authoritativeThread.platform,
        stage: "focus-auto-ack",
        action: "focus_auto_ack_queued",
        status: "OK",
        details: { threadId, personId, windowId: latest.focusWindow.windowId }
      });
      return { type: "queued", personId, clientSendId };
    } catch (error) {
      await deps.auditLog?.({
        platform: thread.platform,
        stage: "focus-auto-ack",
        action: "focus_auto_ack_queued",
        status: "FAIL",
        details: {
          threadId,
          personId,
          windowId: profile.focusWindow.windowId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  async function handleDeliveredSend(
    threadId: string,
    clientSendId: string
  ): Promise<FocusAutoAckResult> {
    const request = await deps.loadSendRequest(clientSendId);
    if (
      !request ||
      request.threadId !== threadId ||
      request.status !== "SENT" ||
      (request.source !== "focus_ack" && request.source !== "focus_auto_ack")
    ) {
      return { type: "skipped", reason: "not_focus_acknowledgement" };
    }
    const [profile, thread] = await Promise.all([
      deps.settingsStore.getOperatorProfile(),
      deps.loadThread(threadId)
    ]);
    if (!thread || !profile.focusWindow.windowId) {
      return { type: "skipped", reason: "thread_not_found" };
    }
    const expectedIds = focusAcknowledgementClientSendIds(
      profile.focusWindow.windowId,
      thread.person.id
    );
    if (!expectedIds.includes(clientSendId)) {
      return { type: "skipped", reason: "focus_window_changed" };
    }
    await deps.settingsStore.acknowledgeFocusWindowPerson(
      profile.focusWindow.windowId,
      thread.person.id
    );
    return { type: "skipped", reason: "already_acknowledged" };
  }

  return { handleThread, handleDeliveredSend };
}

export function bindFocusAutoAckEvents(
  eventBus: Pick<EventBus, "subscribe">,
  service: Pick<
    ReturnType<typeof createFocusAutoAckService>,
    "handleThread" | "handleDeliveredSend"
  >
): () => void {
  return eventBus.subscribe((event) => {
    let work: Promise<FocusAutoAckResult> | null = null;
    let threadId: string | null = null;
    if (event.type === "MESSAGE_SENT" && event.clientSendId) {
      threadId = event.threadId;
      work = service.handleDeliveredSend(event.threadId, event.clientSendId);
    } else if (event.type === "MESSAGES_PERSISTED" || event.type === "THREAD_UPDATED") {
      threadId = event.threadId;
      work = service.handleThread(event.threadId);
    }
    if (!work || !threadId) return;
    void work.catch((error) => {
      console.warn(
        `[focus-auto-ack] failed for threadId=${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  });
}
