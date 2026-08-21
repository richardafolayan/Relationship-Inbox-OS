import type { PlatformName } from "@inbox-os/core";
import { v5 as uuidv5 } from "uuid";
import type { OperatorProfile } from "../types/runtime";
import type { SendQueueService } from "./send-queue";

export interface FocusAutoAckThread {
  threadId: string;
  platform: PlatformName;
  isGroup: boolean;
  category: string | null;
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
    updateOperatorProfile(partial: Partial<OperatorProfile>): Promise<OperatorProfile>;
  };
  sendQueue: Pick<SendQueueService, "enqueueAndKick">;
  loadThread(threadId: string): Promise<FocusAutoAckThread | null>;
  loadSendRequest(clientSendId: string): Promise<{ threadId: string; status: string } | null>;
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

export type FocusAutoAckDeliveryResult =
  | { type: "acknowledged"; personId: string }
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
  if (thread.isGroup || thread.category === "outreach") return false;
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
  return Number.isFinite(startedAt) && (!Number.isFinite(endsAt) || endsAt > now.getTime());
}

export function createFocusAutoAckService(deps: FocusAutoAckDeps) {
  const inFlight = new Set<string>();
  const deliveryInFlight = new Set<string>();
  let deliveryWrites: Promise<void> = Promise.resolve();

  function serializeDeliveryWrite<T>(work: () => Promise<T>): Promise<T> {
    const run = deliveryWrites.then(work, work);
    deliveryWrites = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function handleThread(threadId: string): Promise<FocusAutoAckResult> {
    const profile = await deps.settingsStore.getOperatorProfile();
    const now = deps.now?.() ?? new Date();
    if (!isLiveAutoWindow(profile, now)) return { type: "skipped", reason: "disabled" };

    const thread = await deps.loadThread(threadId);
    if (!thread) return { type: "skipped", reason: "thread_not_found" };
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
    const personId = thread.person.id;
    if (profile.focusWindow.ackedPersonIds.includes(personId)) {
      return { type: "skipped", reason: "already_acknowledged" };
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

      const text = focusAutoAckText(thread, latest);
      if (!text) return { type: "skipped", reason: "empty_note" };
      const clientSendId = uuidv5(key, uuidv5.URL);
      const existing = await deps.loadSendRequest(clientSendId);
      if (existing) {
        if (existing.status === "SENT") {
          const delivered = await handleDelivered({
            threadId: existing.threadId,
            clientSendId
          });
          return delivered.type === "acknowledged"
            ? { type: "skipped", reason: "already_delivered" }
            : delivered;
        }
        return {
          type: "skipped",
          reason: existing.status === "PENDING" ? "already_queued" : "existing_attempt"
        };
      }
      const queueResult = await deps.sendQueue.enqueueAndKick({ threadId, text, clientSendId });
      if (queueResult.status === "SENT") {
        const delivered = await handleDelivered({ threadId, clientSendId });
        return delivered.type === "acknowledged"
          ? { type: "skipped", reason: "already_delivered" }
          : delivered;
      }
      if (queueResult.status === "FAILED") {
        return { type: "skipped", reason: "existing_attempt" };
      }
      await deps.auditLog?.({
        platform: thread.platform,
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

  async function handleDelivered(input: {
    threadId: string;
    clientSendId: string;
  }): Promise<FocusAutoAckDeliveryResult> {
    const profile = await deps.settingsStore.getOperatorProfile();
    if (!isLiveAutoWindow(profile, deps.now?.() ?? new Date())) {
      return { type: "skipped", reason: "disabled" };
    }
    const thread = await deps.loadThread(input.threadId);
    if (!thread) return { type: "skipped", reason: "thread_not_found" };
    if (!focusAutoAckCoverage(thread, profile)) {
      return { type: "skipped", reason: "not_covered" };
    }

    const personId = thread.person.id;
    const key = `${profile.focusWindow.windowId}:${personId}`;
    if (uuidv5(key, uuidv5.URL) !== input.clientSendId) {
      return { type: "skipped", reason: "not_focus_note" };
    }
    if (profile.focusWindow.ackedPersonIds.includes(personId)) {
      return { type: "skipped", reason: "already_acknowledged" };
    }
    if (deliveryInFlight.has(key)) return { type: "skipped", reason: "in_flight" };

    deliveryInFlight.add(key);
    try {
      return await serializeDeliveryWrite<FocusAutoAckDeliveryResult>(async () => {
        const latest = await deps.settingsStore.getOperatorProfile();
        if (
          !isLiveAutoWindow(latest, deps.now?.() ?? new Date()) ||
          latest.focusWindow.windowId !== profile.focusWindow.windowId
        ) {
          return { type: "skipped", reason: "window_changed" };
        }
        if (latest.focusWindow.ackedPersonIds.includes(personId)) {
          return { type: "skipped", reason: "already_acknowledged" };
        }
        await deps.settingsStore.updateOperatorProfile({
          focusWindow: {
            ...latest.focusWindow,
            ackedPersonIds: Array.from(new Set([...latest.focusWindow.ackedPersonIds, personId]))
          }
        });
        await deps.auditLog?.({
          platform: thread.platform,
          stage: "focus-auto-ack",
          action: "focus_auto_ack_delivered",
          status: "OK",
          details: {
            threadId: input.threadId,
            personId,
            windowId: latest.focusWindow.windowId,
            clientSendId: input.clientSendId
          }
        });
        return { type: "acknowledged", personId };
      });
    } finally {
      deliveryInFlight.delete(key);
    }
  }

  return { handleThread, handleDelivered };
}
