"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { AiHelpLevel, OperatorProfile, ReplyStyle } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildPendingSavePartial, type PendingProfileSave } from "@/lib/voice-profile-save";

// The reply-style fields that "Analyse my sent messages" (#438) can fill.
// displayName (identity) and aiHelpLevel (a preference) are never inferred.
type StyleReview = Pick<
  OperatorProfile,
  "about" | "preferredStyle" | "commonPhrases" | "avoidedPhrases" | "interests"
>;

type AnalyzeStyleResponse = {
  ok: boolean;
  reason?: "not_enough_messages" | "ai_unavailable" | "low_confidence";
  sampleCount: number;
  suggestion: StyleReview | null;
};

function analyzeReasonMessage(reason: AnalyzeStyleResponse["reason"]): string {
  if (reason === "not_enough_messages") {
    return "Not enough of your own sent messages yet to read a style. Once you've sent more, try again, or just fill this in yourself.";
  }
  if (reason === "ai_unavailable") {
    return "Couldn't reach the AI just now. Try again in a moment.";
  }
  return "Couldn't read a clear style from your messages. Fill in what fits. You can edit anytime.";
}

// The user's voice + identity setup. Used in two places:
//   - Settings, as the "Your reply style" section (variant="settings")
//   - Today, inside the first-run setup card (variant="onboarding")
// It owns its own fetch + auto-save so both call sites stay thin. Text
// fields auto-save on a debounce; the style and AI-help-level pickers save
// immediately. There is no "AI clone your voice" framing here on purpose —
// this is about helping the app support the user's own words.

const EMPTY_PROFILE: OperatorProfile = {
  displayName: "",
  about: "",
  interests: "",
  commonPhrases: "",
  avoidedPhrases: "",
  preferredStyle: "",
  aiHelpLevel: "writing_support",
  setupCompletedAt: ""
};

const REPLY_STYLES: Array<{ value: ReplyStyle; label: string }> = [
  { value: "warm", label: "Warm" },
  { value: "direct", label: "Direct" },
  { value: "casual", label: "Casual" },
  { value: "thoughtful", label: "Thoughtful" },
  { value: "concise", label: "Concise" }
];

const AI_HELP_LEVELS: Array<{ value: AiHelpLevel; label: string; desc: string }> = [
  {
    value: "memory_only",
    label: "Memory only",
    desc:
      "Show summaries, context, and things to address. No AI ranking on Reconnect, no AI close detection on the Inbox. You write every reply yourself."
  },
  {
    value: "writing_support",
    label: "Writing support",
    desc: "Also help improve drafts you write yourself, like making them shorter or warmer."
  },
  {
    value: "full_drafts",
    label: "Full drafts",
    desc: "Also suggest complete replies you can edit. Nothing ever sends automatically."
  }
];

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function UserVoiceProfile({
  variant = "settings",
  onCompleted,
  className
}: {
  variant?: "settings" | "onboarding";
  onCompleted?: () => void;
  className?: string;
}) {
  const [profile, setProfile] = useState<OperatorProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [finishing, setFinishing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest text save still waiting on the debounce, so we can flush it on
  // unmount instead of dropping it (e.g. a name typed then "Done" clicked).
  const pendingSave = useRef<PendingProfileSave | null>(null);
  // Reply-style analysis (#438). `review` holds an editable suggestion that
  // is NOT persisted until the operator clicks Save, so analysis never writes
  // behind their back.
  const [review, setReview] = useState<StyleReview | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  useEffect(() => {
    void apiGet<OperatorProfile>("/runner/data/operator-profile")
      .then((data) => {
        if (data) setProfile({ ...EMPTY_PROFILE, ...data });
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  // Persist a partial profile to the runner. The runner store is what the
  // AI prompts read, so this is not a UI-only preference.
  const persist = useCallback(async (partial: Partial<OperatorProfile>) => {
    setStatus("saving");
    try {
      const next = await apiPost<OperatorProfile>("/runner/control/operator-profile", partial);
      setProfile({ ...EMPTY_PROFILE, ...next });
      setStatus("saved");
      // Let the sidebar avatar / greeting pick up a name change live.
      window.dispatchEvent(new CustomEvent("operator-profile-saved"));
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(
    () => () => {
      // Flush a still-pending debounced save before tearing down, so the
      // last-typed value (e.g. the onboarding name) isn't lost on unmount.
      const partial = buildPendingSavePartial(pendingSave.current);
      if (partial) void persist(partial);
      pendingSave.current = null;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [persist]
  );


  // Text fields: update local state now, debounce the save.
  const onTextChange = useCallback(
    (field: keyof OperatorProfile, value: string) => {
      setProfile((prev) => ({ ...prev, [field]: value }));
      setStatus("saving");
      // If a DIFFERENT field's edit is still pending on the debounce, flush it
      // now — otherwise replacing pendingSave below would drop that field's
      // just-typed value (it was only ever in local state, never persisted).
      const prevPending = pendingSave.current;
      if (prevPending && prevPending.field !== field) {
        void persist({ [prevPending.field]: prevPending.value });
      }
      pendingSave.current = { field, value };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        pendingSave.current = null;
        void persist({ [field]: value });
      }, 600);
    },
    [persist]
  );

  // Pickers: save immediately, no debounce.
  const onStylePick = useCallback(
    (value: ReplyStyle) => {
      const next: ReplyStyle | "" = profile.preferredStyle === value ? "" : value;
      setProfile((prev) => ({ ...prev, preferredStyle: next }));
      void persist({ preferredStyle: next });
    },
    [persist, profile.preferredStyle]
  );

  const onHelpLevelPick = useCallback(
    (value: AiHelpLevel) => {
      setProfile((prev) => ({ ...prev, aiHelpLevel: value }));
      void persist({ aiHelpLevel: value });
    },
    [persist]
  );

  // While a suggestion is under review, the reply-style fields read + write
  // through the `review` buffer (no auto-save); otherwise they use the
  // normal debounced/immediate persist.
  const styleText = (field: keyof StyleReview): string =>
    review ? (review[field] as string) : (profile[field] as string);
  const onStyleText = useCallback(
    (field: keyof StyleReview, value: string) => {
      if (review) setReview((prev) => (prev ? { ...prev, [field]: value } : prev));
      else onTextChange(field, value);
    },
    [review, onTextChange]
  );
  const toneValue: ReplyStyle | "" = review ? review.preferredStyle : profile.preferredStyle;
  const onStyleTone = useCallback(
    (value: ReplyStyle) => {
      if (review) {
        setReview((prev) =>
          prev ? { ...prev, preferredStyle: prev.preferredStyle === value ? "" : value } : prev
        );
      } else {
        onStylePick(value);
      }
    },
    [review, onStylePick]
  );

  const runAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await apiPost<AnalyzeStyleResponse>(
        "/runner/control/operator-profile/analyze-style",
        {}
      );
      if (!res.ok || !res.suggestion) {
        setAnalyzeError(analyzeReasonMessage(res.reason));
        return;
      }
      const s = res.suggestion;
      // Seed the review with the suggestion, keeping any existing value where
      // the AI had nothing — analysis never blanks a field already filled.
      setReview({
        about: s.about || profile.about,
        preferredStyle: s.preferredStyle || profile.preferredStyle,
        commonPhrases: s.commonPhrases || profile.commonPhrases,
        avoidedPhrases: s.avoidedPhrases || profile.avoidedPhrases,
        interests: s.interests || profile.interests
      });
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Couldn't analyse just now. Try again.");
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, profile]);

  const saveReview = useCallback(async () => {
    if (!review) return;
    setSavingReview(true);
    try {
      await persist(review);
      setReview(null);
    } finally {
      setSavingReview(false);
    }
  }, [persist, review]);

  const discardReview = useCallback(() => {
    setReview(null);
    setAnalyzeError(null);
  }, []);

  const finishSetup = useCallback(async () => {
    setFinishing(true);
    try {
      await persist({ setupCompletedAt: new Date().toISOString() });
      onCompleted?.();
    } finally {
      setFinishing(false);
    }
  }, [onCompleted, persist]);

  const statusLabel = useMemo(() => {
    if (status === "saving") return "saving…";
    if (status === "saved") return "saved";
    if (status === "error") return "failed to save";
    return "";
  }, [status]);

  const isOnboarding = variant === "onboarding";

  return (
    <section
      data-testid="user-voice-profile"
      className={cn(
        "rounded-card border border-hairline bg-paper p-5",
        variant === "settings" && "mt-10",
        className
      )}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div>
          {isOnboarding ? (
            <p className="m-0 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-ink">
              Welcome
            </p>
          ) : null}
          <p
            className={cn(
              "m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3",
              isOnboarding && "mt-1 text-[15px] font-semibold normal-case tracking-normal text-ink"
            )}
          >
            {isOnboarding ? "Set up your reply style" : "Your reply style"}
          </p>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">
            {isOnboarding
              ? "Tovi helps you reply in your own words. Take a minute to tell it how you write, so summaries and any drafts sound like you. You can change all of this later."
              : "Help the app understand how you normally message people. It uses this to support your replies without making everything sound like AI. Nothing here is shared."}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-[11px]",
            status === "error" ? "text-ink-2" : "text-ink-3"
          )}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        <Field label="Your name" hint="What the app calls you. Used for the greeting and your replies.">
          <input
            type="text"
            value={profile.displayName}
            onChange={(event) => onTextChange("displayName", event.target.value)}
            placeholder="e.g. Sam"
            disabled={!loaded}
            className="w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <div className="rounded-row border border-hairline bg-paper-2/40 p-3">
          {review ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[13px] leading-[1.5] text-ink">
                Suggested from your recent sent messages. Review and edit anything below, then save.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveReview()}
                  disabled={savingReview}
                  data-testid="voice-review-save"
                  className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-3 py-[7px] text-[13px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingReview ? (
                    <>
                      <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                      Saving…
                    </>
                  ) : (
                    "Save"
                  )}
                </button>
                <button
                  type="button"
                  onClick={discardReview}
                  disabled={savingReview}
                  className="rounded-pill border border-hairline px-3 py-[7px] text-[13px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong disabled:opacity-50"
                >
                  Discard
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button
                  type="button"
                  onClick={() => void runAnalyze()}
                  disabled={!loaded || analyzing}
                  data-testid="voice-analyze"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-hairline px-3 py-[7px] text-[13px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                      Analysing…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.8} />
                      Analyse my sent messages
                    </>
                  )}
                </button>
                <span className="text-[12px] leading-[1.45] text-ink-3">
                  Optional. Reads your own recent sent messages to suggest the reply-style fields below. Nothing saves until you review and Save.
                </span>
              </div>
              {analyzeError ? (
                <p
                  className="m-0 rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-[1.45] text-ink-2"
                  aria-live="polite"
                >
                  {analyzeError}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <Field
          label="How do you usually message people?"
          hint="A sentence or two in your own words. Plain, warm, short, formal, whatever fits."
        >
          <textarea
            rows={3}
            value={styleText("about")}
            onChange={(event) => onStyleText("about", event.target.value)}
            placeholder="e.g. Short and friendly. I get to the point but I'm never cold about it."
            disabled={!loaded || analyzing}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field
          label="Preferred reply tone"
          hint="Optional. Pick the one closest to how you like your replies to land."
        >
          <div className="flex flex-wrap gap-2">
            {REPLY_STYLES.map((style) => {
              const active = toneValue === style.value;
              return (
                <button
                  key={style.value}
                  type="button"
                  onClick={() => onStyleTone(style.value)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-pill border px-3 py-[6px] text-[13px] transition-colors duration-calm",
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2"
                  )}
                >
                  {style.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Words you use often" hint="Optional. Add phrases that sound natural for you.">
          <textarea
            rows={2}
            value={styleText("commonPhrases")}
            onChange={(event) => onStyleText("commonPhrases", event.target.value)}
            placeholder="e.g. no worries, sounds good, let's do it"
            disabled={!loaded || analyzing}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field label="Words to avoid" hint="Optional. Add phrases you would never say.">
          <textarea
            rows={2}
            value={styleText("avoidedPhrases")}
            onChange={(event) => onStyleText("avoidedPhrases", event.target.value)}
            placeholder="e.g. circle back, touch base, reach out"
            disabled={!loaded || analyzing}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field
          label="Things you care about"
          hint="Optional. Keeps replies in your world: what you work on, what you're into."
        >
          <textarea
            rows={2}
            value={styleText("interests")}
            onChange={(event) => onStyleText("interests", event.target.value)}
            placeholder="e.g. design, running, keeping in touch with old friends"
            disabled={!loaded || analyzing}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <div className="border-t border-hairline pt-5">
          <p className="m-0 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
            AI help level
          </p>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-ink-2">
            Choose how much help you want from the app. Summaries and things to address always
            show. Higher tiers also offer writing help and turn on AI ranking on the Reconnect
            page and AI close-detection on the Inbox.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {AI_HELP_LEVELS.map((level) => {
              const active = profile.aiHelpLevel === level.value;
              return (
                <button
                  key={level.value}
                  type="button"
                  onClick={() => onHelpLevelPick(level.value)}
                  aria-pressed={active}
                  data-testid={`ai-help-${level.value}`}
                  className={cn(
                    "flex items-start gap-3 rounded-row border px-3 py-[10px] text-left transition-colors duration-calm",
                    active
                      ? "border-ink bg-paper-2"
                      : "border-hairline hover:border-hairline-strong hover:bg-paper-2/60"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[2px] grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full border",
                      active ? "border-ink" : "border-hairline-strong"
                    )}
                  >
                    {active ? <span className="h-[8px] w-[8px] rounded-full bg-ink" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium text-ink">{level.label}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-[1.5] text-ink-3">
                      {level.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {isOnboarding ? (
          <div className="flex items-center gap-3 border-t border-hairline pt-5">
            <button
              type="button"
              onClick={() => void finishSetup()}
              disabled={finishing || !loaded}
              className="rounded-pill bg-ink px-4 py-[9px] text-[13px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {finishing ? "Saving…" : "Done, take me in"}
            </button>
            <span className="text-[12px] text-ink-3">You can change any of this later in Settings.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {hint ? <span className="mt-0.5 block text-[12px] leading-[1.45] text-ink-3">{hint}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}
