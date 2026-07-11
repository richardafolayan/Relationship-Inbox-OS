"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Star, X } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { isCurrentDrawerRequest } from "@/lib/drawer-request-guard";
import { setFavourite } from "@/lib/favourites";
import { normalizePriorityGroups, setPriorityGroups } from "@/lib/priority-groups";
import type { PersonDetailResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProfileSections } from "./profile-sections";

interface FriendshipSummary {
  how_you_know_each_other: string;
  recent_topics: string[];
  inside_jokes: string[];
  vibe: string;
}

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
  const [friendshipSummary, setFriendshipSummary] = useState<FriendshipSummary | null>(null);
  const [generatingFriendship, setGeneratingFriendship] = useState(false);
  // Optimistic favourite override (R-0066 / #483). null = follow the loaded
  // detail; a boolean wins until the toggle settles, reverting on failure.
  const [favOverride, setFavOverride] = useState<boolean | null>(null);
  const [favSaving, setFavSaving] = useState(false);
  const [groupInput, setGroupInput] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  // Per-open-session request token (mirrors the thread page's route-id guard).
  // Advanced on every open and every personId change so a slow friendship-summary
  // response that resolves after the drawer closed (or switched contact) can be
  // discarded instead of resurfacing on the next open.
  const drawerRequestTokenRef = useRef(0);

  useEffect(() => {
    if (!open || !personId) return;
    // Start a new request session: bump the token so any in-flight summary
    // writeback from the previous open/person is ignored, and clear last
    // session's output so a post-close response can't survive into this open.
    drawerRequestTokenRef.current += 1;
    setFriendshipSummary(null);
    // Drop the response if the drawer is closed (or switched to a
    // different person) before the fetch resolves — otherwise a slow
    // load can briefly flash stale data when the operator reopens the
    // drawer for a different contact.
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Clear any stale optimistic favourite from a previous contact.
    setFavOverride(null);
    apiGet<PersonDetailResponse>(`/runner/data/person/${personId}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load profile");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, personId]);

  // Reset transient state when the drawer closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setDetail(null);
      setProfileUrlInput("");
      setError(null);
      setFriendshipSummary(null);
      setFavOverride(null);
      setGroupInput("");
    }
  }, [open]);

  const favourite = favOverride ?? detail?.person.favourite ?? false;
  const toggleFavourite = async () => {
    if (!personId) return;
    const next = !favourite;
    setFavOverride(next);
    setFavSaving(true);
    setError(null);
    try {
      await setFavourite(personId, next);
    } catch (err) {
      setFavOverride(!next);
      setError(err instanceof Error ? err.message : "Failed to update favourite");
    } finally {
      setFavSaving(false);
    }
  };

  const saveGroups = async (nextGroups: string[]) => {
    if (!personId || !detail) return;
    const groups = normalizePriorityGroups(nextGroups);
    setGroupSaving(true);
    setError(null);
    const previous = detail.person.tags;
    setDetail({ ...detail, person: { ...detail.person, tags: groups } });
    try {
      const saved = await setPriorityGroups(personId, groups);
      setDetail((current) => current ? { ...current, person: { ...current.person, tags: saved } } : current);
    } catch (err) {
      setDetail((current) => current ? { ...current, person: { ...current.person, tags: previous } } : current);
      setError(err instanceof Error ? err.message : "Failed to save groups");
    } finally {
      setGroupSaving(false);
    }
  };

  const addGroup = async () => {
    if (!detail) return;
    const group = groupInput.trim();
    if (!group) return;
    setGroupInput("");
    await saveGroups([...detail.person.tags, group]);
  };

  const generateFriendshipSummary = async () => {
    if (!personId) return;
    setGeneratingFriendship(true);
    setError(null);
    const startToken = drawerRequestTokenRef.current;
    try {
      const result = await apiPost<FriendshipSummary>(
        `/runner/control/person/${personId}/friendship-summary`,
        {}
      );
      if (!isCurrentDrawerRequest(startToken, drawerRequestTokenRef.current)) return;
      setFriendshipSummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate friendship summary");
    } finally {
      setGeneratingFriendship(false);
    }
  };

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
            {/* Favourite toggle (R-0066 / #483). Pins the contact so their
                threads float to the top of the Inbox / Today. */}
            <Button
              variant="quiet"
              disabled={!detail || favSaving}
              onClick={() => void toggleFavourite()}
              aria-pressed={favourite}
              className={cn(favourite ? "text-accent" : "")}
            >
              <Star
                className="h-[14px] w-[14px]"
                strokeWidth={1.6}
                fill={favourite ? "currentColor" : "none"}
              />
              {favourite ? "Favourited" : "Favourite"}
            </Button>
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
          <p className="mb-4 rounded-row border border-hairline bg-paper-2 px-3 py-2 text-[12px] leading-[1.45] text-ink-2">{error}</p>
        ) : null}

        <div className="flex-1 overflow-y-auto pb-8">
          {loading && !detail ? (
            <p className="text-[13px] text-ink-3">Loading…</p>
          ) : detail ? (
            <>
              <ProfileSections detail={detail} />
              <section className="mt-6 border-t border-hairline pt-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Groups
                  </p>
                  {groupSaving ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-3">
                      <Loader2 className="h-[12px] w-[12px] animate-spin" />
                      Saving
                    </span>
                  ) : null}
                </div>
                {detail.person.tags.length > 0 ? (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {detail.person.tags.map((group) => (
                      <span
                        key={group}
                        className="inline-flex items-center gap-[6px] rounded-pill border border-hairline bg-paper-2 px-[9px] py-[4px] text-[12px] text-ink-2"
                      >
                        {group}
                        <button
                          type="button"
                          disabled={groupSaving}
                          aria-label={`Remove ${group}`}
                          className="rounded p-[1px] text-ink-3 hover:text-ink"
                          onClick={() => void saveGroups(detail.person.tags.filter((item) => item !== group))}
                        >
                          <X className="h-[12px] w-[12px]" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={groupInput}
                    onChange={(event) => setGroupInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addGroup();
                      }
                    }}
                    placeholder="Close friends"
                    className="w-[240px] max-w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
                  />
                  <Button
                    variant="quiet"
                    disabled={!groupInput.trim() || groupSaving}
                    onClick={() => void addGroup()}
                  >
                    <Plus className="h-[14px] w-[14px]" />
                    Add group
                  </Button>
                </div>
              </section>
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
              {detail.person.platform === "IMESSAGE" ? (
                <FriendshipSummarySection
                  summary={friendshipSummary}
                  generating={generatingFriendship}
                  onGenerate={generateFriendshipSummary}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FriendshipSummarySection({
  summary,
  generating,
  onGenerate
}: {
  summary: FriendshipSummary | null;
  generating: boolean;
  onGenerate: () => void | Promise<void>;
}) {
  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
          Friendship summary
        </p>
        <Button
          variant="quiet"
          disabled={generating}
          onClick={() => void onGenerate()}
        >
          {generating ? (
            <Loader2 className="h-[14px] w-[14px] animate-spin" />
          ) : null}
          {generating ? "Generating…" : summary ? "Regenerate" : "Generate"}
        </Button>
      </div>
      {!summary && !generating ? (
        <p className="m-0 text-[13px] text-ink-3">
          AI-written profile based on your iMessage history with this person. Four sections covering how you know each other, recent topics, inside jokes, and the vibe.
        </p>
      ) : null}
      {summary ? (
        <div className="flex flex-col gap-5">
          <FriendshipBlock title="How you know each other" body={summary.how_you_know_each_other} />
          {summary.recent_topics.length > 0 ? (
            <FriendshipList title="Recent topics" items={summary.recent_topics} />
          ) : null}
          {summary.inside_jokes.length > 0 ? (
            <FriendshipList title="Inside jokes / running threads" items={summary.inside_jokes} />
          ) : null}
          <FriendshipBlock title="Their vibe with you" body={summary.vibe} />
        </div>
      ) : null}
    </section>
  );
}

function FriendshipBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="m-0 mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
        {title}
      </p>
      <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-ink">{body}</p>
    </div>
  );
}

function FriendshipList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="m-0 mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
        {title}
      </p>
      <ul className="m-0 list-disc pl-5 text-[13.5px] leading-[1.55] text-ink">
        {items.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
