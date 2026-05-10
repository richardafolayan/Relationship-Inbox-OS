"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { PersonDetailResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
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
  const [askQuestion, setAskQuestion] = useState("");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

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
      setFriendshipSummary(null);
      setAskQuestion("");
      setAskAnswer(null);
    }
  }, [open]);

  const askAboutPerson = async () => {
    if (!personId) return;
    const trimmed = askQuestion.trim();
    if (!trimmed) return;
    setAsking(true);
    setAskAnswer(null);
    setError(null);
    try {
      const result = await apiPost<{ answer: string }>(
        `/runner/control/person/${personId}/ask`,
        { question: trimmed }
      );
      setAskAnswer(result.answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ask the AI");
    } finally {
      setAsking(false);
    }
  };

  const generateFriendshipSummary = async () => {
    if (!personId) return;
    setGeneratingFriendship(true);
    setError(null);
    try {
      const result = await apiPost<FriendshipSummary>(
        `/runner/control/person/${personId}/friendship-summary`,
        {}
      );
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
              {detail.person.platform === "IMESSAGE" ? (
                <FriendshipSummarySection
                  summary={friendshipSummary}
                  generating={generatingFriendship}
                  onGenerate={generateFriendshipSummary}
                />
              ) : null}
              <AskAISection
                question={askQuestion}
                onQuestionChange={setAskQuestion}
                answer={askAnswer}
                asking={asking}
                onAsk={askAboutPerson}
              />
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

function AskAISection({
  question,
  onQuestionChange,
  answer,
  asking,
  onAsk
}: {
  question: string;
  onQuestionChange: (value: string) => void;
  answer: string | null;
  asking: boolean;
  onAsk: () => void | Promise<void>;
}) {
  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <p className="m-0 mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
        Ask the AI about them
      </p>
      <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-ink-3">
        Free-form questions grounded in your message history, their enrichment, and your notes. The AI can cite specific dates from your conversations and will say so when something hasn't come up.
      </p>
      <textarea
        value={question}
        onChange={(event) => onQuestionChange(event.target.value)}
        placeholder="e.g. what does she think about consulting? when did they last mention Lagos?"
        rows={3}
        className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="primary"
          disabled={asking || !question.trim()}
          onClick={() => void onAsk()}
        >
          {asking ? (
            <Loader2 className="h-[14px] w-[14px] animate-spin" />
          ) : null}
          {asking ? "Asking…" : "Ask"}
        </Button>
      </div>
      {answer ? (
        <div className="mt-3 rounded-row border border-hairline bg-paper p-3 text-[13.5px] leading-[1.55] text-ink">
          <p className="m-0 whitespace-pre-wrap">{answer}</p>
        </div>
      ) : null}
    </section>
  );
}
