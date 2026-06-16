"use client";

import { apiPost } from "@/lib/api";
import { showToast } from "@/lib/feedback";
import { dismissCenterNotification, markCenterNotificationsSeen } from "@/lib/notification-center";
import { UPDATE_NOTICE_ID } from "@/lib/update-notice";

interface UpdateStartResponse {
  ok: boolean;
  updating?: boolean;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  message?: string;
}

let inFlight: Promise<UpdateStartResponse> | null = null;

export function startAppUpdate(latestVersion?: string): Promise<UpdateStartResponse> {
  if (inFlight) return inFlight;
  markCenterNotificationsSeen([UPDATE_NOTICE_ID]);
  showToast({
    id: UPDATE_NOTICE_ID,
    kind: "pending",
    title: latestVersion ? `Updating to v${latestVersion}…` : "Updating app…",
    description: "Relationship Inbox OS will close and reopen itself."
  });

  inFlight = apiPost<UpdateStartResponse>("/runner/system/update", {})
    .then((res) => {
      dismissCenterNotification(UPDATE_NOTICE_ID);
      showToast({
        id: UPDATE_NOTICE_ID,
        kind: "success",
        title: "Update started",
        description: res.message ?? "The app will reopen when it finishes.",
        durationMs: 12_000
      });
      return res;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : "Couldn’t start the update.";
      showToast({
        id: UPDATE_NOTICE_ID,
        kind: "error",
        title: "Couldn’t start update",
        description: message,
        durationMs: 10_000
      });
      return { ok: false, reason: message };
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
