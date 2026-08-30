"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useFocusWindow } from "@/lib/use-focus-window";
import type { AckTemplates, FocusAudience, FocusSettings } from "@/lib/types";

// Settings -> Focus Reply Buffer. Mirrors the page's own group/row/toggle
// styling (those primitives are page-local) so it reads as one more settings
// section. Toggles + audience save immediately; the note templates debounce
// like the voice profile, with a flush on blur.

const TEXTAREA_DEBOUNCE_MS = 600;

const AUDIENCE_OPTIONS: Array<{ value: FocusAudience; name: string; desc: string }> = [
  {
    value: "favourites",
    name: "Favourites only",
    desc: "Close personal contacts you've starred. The safest default."
  },
  {
    value: "all_personal",
    name: "All personal contacts",
    desc: "Anyone saved as a real person on iMessage. Strangers and businesses are still left alone."
  }
];

export function FocusSettingsSection() {
  const { profile, settings, templates, saveSettings, saveTemplates } = useFocusWindow();
  const [local, setLocal] = useState<FocusSettings>(settings);
  const [tpl, setTpl] = useState<AckTemplates>(templates);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const hydrated = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTpl = useRef<AckTemplates | null>(null);

  // Hydrate local editor state once the real profile lands, then own it
  // locally so a background profile refresh can't clobber an in-progress edit.
  useEffect(() => {
    if (profile && !hydrated.current) {
      setLocal(settings);
      setTpl(templates);
      hydrated.current = true;
    }
  }, [profile, settings, templates]);

  // Flush any pending template save on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (pendingTpl.current) void saveTemplates(pendingTpl.current);
    },
    [saveTemplates]
  );

  const persistSettings = async (next: FocusSettings) => {
    setStatus("saving");
    try {
      await saveSettings(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const toggle = (key: "reasonLabel") => {
    const next = { ...local, [key]: !local[key] };
    setLocal(next);
    void persistSettings(next);
  };

  const chooseAudience = (audience: FocusAudience) => {
    const next = { ...local, audience };
    setLocal(next);
    void persistSettings(next);
  };

  const editTemplate = (tier: keyof AckTemplates, value: string) => {
    const next = { ...tpl, [tier]: value };
    setTpl(next);
    pendingTpl.current = next;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const toSave = pendingTpl.current;
      pendingTpl.current = null;
      if (!toSave) return;
      setStatus("saving");
      saveTemplates(toSave)
        .then(() => setStatus("saved"))
        .catch(() => setStatus("error"));
    }, TEXTAREA_DEBOUNCE_MS);
  };

  const flushTemplate = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const toSave = pendingTpl.current;
    pendingTpl.current = null;
    if (!toSave) return;
    setStatus("saving");
    saveTemplates(toSave)
      .then(() => setStatus("saved"))
      .catch(() => setStatus("error"));
  };

  return (
    <section className="mb-9">
      <div className="mb-3 flex items-baseline gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Focus Reply Buffer
        </p>
        {status === "saving" ? (
          <span className="font-mono text-[10px] text-ink-3">saving…</span>
        ) : status === "saved" ? (
          <span className="font-mono text-[10px] text-ink-3">saved</span>
        ) : status === "error" ? (
          <span className="text-[11px] text-ink-2">Couldn’t save. Try again.</span>
        ) : null}
      </div>

      <div className="border-b border-hairline">
        <ToggleRow
          name="Include a reason label"
          desc='Add a short word like "deep work" or "lecture" to your note, so people know it is a real block and not a brush-off. You pick the word each time.'
          on={local.reasonLabel}
          onChange={() => toggle("reasonLabel")}
        />
      </div>

      <div className="mt-[18px] rounded-card border border-hairline bg-paper p-6">
        <p className="mb-[10px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
          Your acknowledgement notes
        </p>
        <p className="m-0 mb-[18px] max-w-[64ch] text-[13.5px] leading-[1.5] text-ink-2">
          Two notes in your own words, matched to who is writing. Close contacts get the casual one,
          professional contacts get the calmer one.{" "}
          <span className="text-accent-ink">[Name]</span> fills in their first name and{" "}
          <span className="text-accent-ink">[until]</span> your end time. Nothing is ever sent
          without you tapping send.
        </p>

        <TemplateField
          label="For close contacts"
          hint="Friends, family, the people you'd text without thinking about it."
          value={tpl.close}
          onChange={(value) => editTemplate("close", value)}
          onBlur={flushTemplate}
        />
        <TemplateField
          label="For professional contacts"
          hint="Calmer, a little more measured. Still you, not a corporate auto-reply."
          value={tpl.professional}
          onChange={(value) => editTemplate("professional", value)}
          onBlur={flushTemplate}
        />

        <div className="mt-6">
          <p className="mb-[10px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
            Who it applies to
          </p>
          <p className="m-0 mb-2 max-w-[64ch] text-[12px] leading-[1.5] text-ink-3">
            By default, only the people you have marked as favourites. Widen it only if it feels
            safe. Unknown numbers and spam are never acknowledged.
          </p>
          <div className="flex flex-col gap-2">
            {AUDIENCE_OPTIONS.map((option) => {
              const on = local.audience === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseAudience(option.value)}
                  className={cn(
                    "grid grid-cols-[18px_1fr] items-start gap-3 rounded-[12px] border px-4 py-[13px] text-left transition-colors duration-calm",
                    on
                      ? "border-accent bg-accent-soft"
                      : "border-hairline bg-paper hover:border-hairline-strong"
                  )}
                >
                  <span
                    className={cn(
                      "mt-[1px] grid h-[18px] w-[18px] place-items-center rounded-full border",
                      on ? "border-accent" : "border-hairline-strong"
                    )}
                  >
                    {on ? <span className="h-[8px] w-[8px] rounded-full bg-accent" /> : null}
                  </span>
                  <span>
                    <span className="block text-[14px] font-medium text-ink">{option.name}</span>
                    <span className="block text-[12.5px] text-ink-3">{option.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ToggleRow({
  name,
  desc,
  on,
  onChange
}: {
  name: string;
  desc: string;
  on: boolean;
  onChange: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onChange}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onChange();
        }
      }}
      className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-[6px] border-t border-hairline px-1 py-[16px] transition-colors duration-calm hover:bg-paper-2/60 focus:bg-paper-2/60 focus:outline-none sm:gap-6"
    >
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">{name}</p>
        <p className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3" style={{ textWrap: "pretty" }}>
          {desc}
        </p>
      </div>
      <div className="flex items-center gap-[10px]" onClick={(event) => event.stopPropagation()}>
        <span className="font-mono text-[11px] text-ink-3">{on ? "On" : "Off"}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={name}
          onClick={onChange}
          className={cn(
            "relative h-[20px] w-[36px] shrink-0 cursor-pointer rounded-pill transition-colors duration-calm",
            on ? "bg-accent" : "bg-hairline-strong"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm",
              on ? "translate-x-[18px]" : "translate-x-[2px]"
            )}
          />
        </button>
      </div>
    </div>
  );
}

function TemplateField({
  label,
  hint,
  value,
  onChange,
  onBlur
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <div className="mt-4">
      <label className="mb-1 block text-[13.5px] font-medium text-ink">{label}</label>
      <p className="mb-2 text-[12px] text-ink-3">{hint}</p>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        rows={2}
        className="w-full resize-y rounded-[9px] border border-hairline bg-paper px-3 py-[10px] text-[13.5px] leading-[1.5] text-ink outline-none transition-colors duration-calm focus:border-accent"
      />
    </div>
  );
}
