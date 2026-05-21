"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Bug, Check, Copy, ExternalLink, MessageSquareText, X } from "lucide-react";
import {
  buildBugReportTemplate,
  buildFeedbackTemplate,
  describeRoute,
  extractThreadId,
  onPilotFeedback,
  type PilotFeedbackMode
} from "@/lib/pilot";
import { cn } from "@/lib/utils";

// Optional external form. If unset, the modal is fully self-contained: a
// copy-to-clipboard template. No backend, no telemetry.
const feedbackFormUrl = process.env.NEXT_PUBLIC_FEEDBACK_FORM_URL?.trim() || null;
const appVersion = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "0.1.0";

// Pilot feedback + bug report modal. Mounted once in the app shell; opened
// from anywhere via openPilotFeedback(). It never reads or sends message
// content — a tester copies the template and shares it themselves.
export function PilotFeedbackModal() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PilotFeedbackMode>("feedback");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const templateFor = useCallback(
    (next: PilotFeedbackMode): string => {
      if (next === "bug") {
        return buildBugReportTemplate({
          route: describeRoute(pathname),
          threadId: extractThreadId(pathname),
          appVersion,
          timestamp: new Date().toISOString()
        });
      }
      return buildFeedbackTemplate();
    },
    [pathname]
  );

  useEffect(
    () =>
      onPilotFeedback((nextMode) => {
        setMode(nextMode);
        setDraft(templateFor(nextMode));
        setCopied(false);
        setOpen(true);
      }),
    [templateFor]
  );

  const switchMode = useCallback(
    (next: PilotFeedbackMode) => {
      setMode(next);
      setDraft(templateFor(next));
      setCopied(false);
    },
    [templateFor]
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }, [draft]);

  if (!open) return null;

  const isBug = mode === "bug";

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-start justify-items-center bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] pt-[14vh] backdrop-blur-md"
      onClick={() => setOpen(false)}
      onKeyDown={(event) => {
        // Keep keystrokes inside the modal: Escape closes it, and nothing
        // leaks to the page-level R/S/E or `[` shortcuts.
        event.stopPropagation();
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isBug ? "Report a bug" : "Share feedback"}
        className="flex w-[min(560px,92vw)] flex-col overflow-hidden rounded-[18px] border border-hairline bg-paper shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-5 py-[14px]">
          <div className="flex gap-[4px]" role="tablist">
            <ModeTab
              active={!isBug}
              onClick={() => switchMode("feedback")}
              icon={<MessageSquareText className="h-[14px] w-[14px]" strokeWidth={1.7} />}
              label="Share feedback"
            />
            <ModeTab
              active={isBug}
              onClick={() => switchMode("bug")}
              icon={<Bug className="h-[14px] w-[14px]" strokeWidth={1.7} />}
              label="Report a bug"
            />
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            title="Close (Esc)"
            className="ml-auto grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
        </header>

        <div className="px-5 py-4">
          <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
            {isBug
              ? "Describe what went wrong. The context at the bottom is filled in for you — no message content is included."
              : "Tell Richard where this helped, felt wrong, or felt too AI. Edit the notes below, then copy them."}
          </p>

          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={isBug ? 14 : 10}
            spellCheck={false}
            className="mt-3 w-full resize-none rounded-row border border-hairline bg-paper-2 px-3 py-[10px] font-mono text-[12.5px] leading-[1.6] text-ink outline-none transition-[border-color] duration-calm focus:border-hairline-strong"
          />

          <div className="mt-3 flex flex-wrap items-center gap-[10px]">
            <button
              type="button"
              onClick={onCopy}
              className={cn(
                "inline-flex items-center gap-2 rounded-pill px-[16px] py-[9px] text-[12.5px] font-medium transition-colors duration-calm",
                copied
                  ? "bg-risk-fresh/15 text-risk-fresh"
                  : "bg-ink text-paper hover:bg-[oklch(28%_0.01_80)]"
              )}
            >
              {copied ? (
                <Check className="h-[14px] w-[14px]" strokeWidth={2} />
              ) : (
                <Copy className="h-[14px] w-[14px]" strokeWidth={1.7} />
              )}
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
            {!isBug && feedbackFormUrl ? (
              <a
                href={feedbackFormUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-pill border border-hairline px-[16px] py-[9px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
              >
                <ExternalLink className="h-[14px] w-[14px]" strokeWidth={1.7} />
                Open feedback form
              </a>
            ) : null}
          </div>
        </div>

        <footer className="border-t border-hairline px-5 py-3">
          <p className="m-0 text-[11.5px] leading-[1.5] text-ink-3">
            Nothing here is sent automatically. Copy the text and share it with Richard yourself —
            only what you&apos;re comfortable sharing.
          </p>
        </footer>
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-[7px] rounded-[9px] px-[11px] py-[7px] text-[12.5px] font-medium transition-colors duration-calm",
        active ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2 hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
