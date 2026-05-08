"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { PersonDetailResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ProfileSections } from "./profile-sections";

interface ProfileDrawerProps {
  open: boolean;
  personId: string | null;
  onClose: () => void;
}

export function ProfileDrawer({ open, personId, onClose }: ProfileDrawerProps) {
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileUrlInput, setProfileUrlInput] = useState("");
  const [savingProfileUrl, setSavingProfileUrl] = useState(false);

  useEffect(() => {
    if (!open || !personId) return;
    setLoading(true);
    setError(null);
    apiGet<PersonDetailResponse>(`/runner/data/person/${personId}`)
      .then((data) => setDetail(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setLoading(false));
  }, [open, personId]);

  // Reset transient state when the drawer closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setDetail(null);
      setProfileUrlInput("");
      setError(null);
    }
  }, [open]);

  const rescan = () => {
    if (!personId) return;
    setRefreshing(true);
    runAction(
      apiPost(`/runner/control/person/${personId}/enrich?wait=1`, {}).finally(() =>
        setRefreshing(false)
      ),
      setError,
      async () => {
        if (!personId) return;
        const fresh = await apiGet<PersonDetailResponse>(`/runner/data/person/${personId}`);
        setDetail(fresh);
      }
    );
  };

  const saveProfileUrl = async () => {
    if (!personId) return;
    const url = profileUrlInput.trim();
    if (!url) return;
    setSavingProfileUrl(true);
    setError(null);
    try {
      await apiPost(`/runner/control/person/${personId}/profile-url`, { profileUrl: url });
      setProfileUrlInput("");
      const fresh = await apiGet<PersonDetailResponse>(`/runner/data/person/${personId}`);
      setDetail(fresh);
      rescan();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile URL");
    } finally {
      setSavingProfileUrl(false);
    }
  };

  if (!open) return null;

  const profileUrlMissing = !!detail && !detail.person.profileUrl;

  return (
    <div
      className="fixed inset-0 z-50 bg-[color-mix(in_oklch,var(--ink)_24%,transparent)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col border-l border-hairline bg-paper p-7 shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">Profile</p>
          <div className="flex items-center gap-2">
            <Button variant="quiet" disabled={refreshing || !detail?.person.profileUrl} onClick={rescan}>
              {refreshing ? (
                <Loader2 className="h-[14px] w-[14px] animate-spin" />
              ) : (
                <RefreshCw className="h-[14px] w-[14px]" strokeWidth={1.6} />
              )}
              {refreshing ? "Rescanning…" : "Rescan"}
            </Button>
            <Button variant="ghost" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {error ? (
          <p className="mb-4 font-mono text-[11px] text-risk-overdue">{error}</p>
        ) : null}

        <div className="flex-1 overflow-y-auto pb-8">
          {loading && !detail ? (
            <p className="text-[13px] text-ink-3">Loading…</p>
          ) : detail ? (
            <>
              <ProfileSections detail={detail} />
              {profileUrlMissing ? (
                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <input
                    type="url"
                    value={profileUrlInput}
                    onChange={(event) => setProfileUrlInput(event.target.value)}
                    placeholder="https://www.linkedin.com/in/…"
                    className="w-[360px] max-w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
                  />
                  <Button
                    variant="quiet"
                    disabled={!profileUrlInput.trim() || savingProfileUrl || refreshing}
                    onClick={() => void saveProfileUrl()}
                  >
                    {savingProfileUrl || refreshing ? "Saving…" : "Save & enrich"}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
