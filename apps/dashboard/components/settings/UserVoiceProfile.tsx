"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import type { AiHelpLevel, OperatorProfile, ReplyStyle } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  onCompleted
}: {
  variant?: "settings" | "onboarding";
  onCompleted?: () => void;
}) {
  const [profile, setProfile] = useState<OperatorProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [finishing, setFinishing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void apiGet<OperatorProfile>("/runner/data/operator-profile")
      .then((data) => {
        if (data) setProfile({ ...EMPTY_PROFILE, ...data });
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

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

  // Text fields: update local state now, debounce the save.
  const onTextChange = useCallback(
    (field: keyof OperatorProfile, value: string) => {
      setProfile((prev) => ({ ...prev, [field]: value }));
      setStatus("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
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
        variant === "settings" && "mt-10"
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
              ? "Relationship Inbox OS helps you reply in your own words. Take a minute to tell it how you write, so summaries and any drafts sound like you. You can change all of this later."
              : "Help the app understand how you normally message people. It uses this to support your replies without making everything sound like AI. Nothing here is shared."}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 font-mono text-[11px]",
            status === "error" ? "text-risk-overdue" : "text-ink-3"
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

        <Field
          label="How do you usually message people?"
          hint="A sentence or two in your own words. Plain, warm, short, formal, whatever fits."
        >
          <textarea
            rows={3}
            value={profile.about}
            onChange={(event) => onTextChange("about", event.target.value)}
            placeholder="e.g. Short and friendly. I get to the point but I'm never cold about it."
            disabled={!loaded}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field
          label="Preferred reply tone"
          hint="Optional. Pick the one closest to how you like your replies to land."
        >
          <div className="flex flex-wrap gap-2">
            {REPLY_STYLES.map((style) => {
              const active = profile.preferredStyle === style.value;
              return (
                <button
                  key={style.value}
                  type="button"
                  onClick={() => onStylePick(style.value)}
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
            value={profile.commonPhrases}
            onChange={(event) => onTextChange("commonPhrases", event.target.value)}
            placeholder="e.g. no worries, sounds good, let's do it"
            disabled={!loaded}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field label="Words to avoid" hint="Optional. Add phrases you would never say.">
          <textarea
            rows={2}
            value={profile.avoidedPhrases}
            onChange={(event) => onTextChange("avoidedPhrases", event.target.value)}
            placeholder="e.g. circle back, touch base, reach out"
            disabled={!loaded}
            className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
          />
        </Field>

        <Field
          label="Things you care about"
          hint="Optional. Keeps replies in your world: what you work on, what you're into."
        >
          <textarea
            rows={2}
            value={profile.interests}
            onChange={(event) => onTextChange("interests", event.target.value)}
            placeholder="e.g. design, running, keeping in touch with old friends"
            disabled={!loaded}
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
