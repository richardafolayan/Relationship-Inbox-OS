"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ImageUp, X } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { showToast } from "@/lib/feedback";
import { signalReportSendStart } from "@/lib/pilot-report-status";
import {
  ALLOWED_SCREENSHOT_TYPES,
  MAX_SCREENSHOTS,
  PILOT_REPORT_TYPES,
  PILOT_REPORT_TYPE_LABELS,
  buildPilotReportPayload,
  collectPilotMeta,
  onPilotFeedback,
  mergeScreenshots,
  validateScreenshotFile,
  type PilotReportType
} from "@/lib/pilot";
import { cn } from "@/lib/utils";

interface StatusReport {
  reportId: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  note: string;
}

interface PickedScreenshot {
  id: string;
  name: string;
  dataUrl: string;
  size: number;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Pilot feedback + bug report modal. Mounted once in the app shell; opened
// from anywhere via openPilotFeedback(). It collects a tester's typed
// report (and any screenshots they attach) and posts it to the
// local runner, which forwards it to the feedback webhook. It never reads
// or sends message content.
export function PilotFeedbackModal() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"form" | "reports">("form");

  const [type, setType] = useState<PilotReportType>("feedback");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [screenshots, setScreenshots] = useState<PickedScreenshot[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [privacyAck, setPrivacyAck] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Submit closes the modal immediately and runs the POST in the
  // background (issue #383 / R-0030 — reverses the earlier decision to
  // lock the form while in flight). Result lands as a success / error
  // toast so the operator can do other things while it sends. No local
  // submitting state, no inline error, no close-lock.

  const [reports, setReports] = useState<StatusReport[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotIdRef = useRef(0);

  const resetForm = useCallback(() => {
    setTitle("");
    setDescription("");
    setExpected("");
    setScreenshots([]);
    setScreenshotError(null);
    setPrivacyAck(false);
  }, []);

  useEffect(
    () =>
      onPilotFeedback((nextType) => {
        setType(nextType);
        setView("form");
        setOpen(true);
      }),
    []
  );

  // When the last screenshot is removed, the privacy note unmounts; drop the
  // acknowledgement so re-attaching an image asks for it again.
  useEffect(() => {
    if (screenshots.length === 0) setPrivacyAck(false);
  }, [screenshots.length]);

  const acceptFiles = useCallback(
    async (fileList: FileList | null | undefined) => {
      const files = fileList ? Array.from(fileList) : [];
      if (files.length === 0) return;
      setScreenshotError(null);
      const picked: PickedScreenshot[] = [];
      let error: string | null = null;
      for (const file of files) {
        const check = validateScreenshotFile({ type: file.type, size: file.size });
        if (!check.ok) {
          error = check.error;
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          screenshotIdRef.current += 1;
          picked.push({
            id: `s${screenshotIdRef.current}`,
            name: file.name,
            dataUrl,
            size: file.size
          });
        } catch {
          error = "Could not read that image.";
        }
      }
      if (picked.length > 0) {
        setScreenshots((prev) => {
          const { merged, overflow } = mergeScreenshots(prev, picked);
          if (overflow) {
            error = `You can attach up to ${MAX_SCREENSHOTS} images.`;
          }
          return merged;
        });
      } else if (picked.length === 0 && MAX_SCREENSHOTS - 0 <= 0) {
        error = `You can attach up to ${MAX_SCREENSHOTS} images.`;
      }
      if (error) setScreenshotError(error);
    },
    []
  );

  const removeScreenshot = useCallback((id: string) => {
    setScreenshots((prev) => prev.filter((shot) => shot.id !== id));
    setScreenshotError(null);
  }, []);

  const canSubmit =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    (screenshots.length === 0 || privacyAck);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const payload = buildPilotReportPayload({
      type,
      title,
      description,
      expected,
      privacyAck,
      meta: collectPilotMeta(pathname),
      screenshots: screenshots.map((shot) => ({ name: shot.name, dataUrl: shot.dataUrl }))
    });
    // Issue #383 / R-0030. Reverses the #337 decision: pilot asked for
    // the form to close immediately on submit so they can keep working
    // while the report sends. The send runs in the background and the
    // outcome (success / error) lands as a toast. There is no in-flight
    // UI here — the toast surface owns the result.
    //
    // Issue #421 / R-0047. The trade-off above (no in-flight UI) left
    // the operator with no signal that the report was still uploading,
    // only a discrete completion toast. Signal in-flight to the
    // TopStatus ticker so "Sending report…" appears alongside the
    // other ticker states until the POST settles.
    setOpen(false);
    resetForm();
    const stopReportSendSignal = signalReportSendStart();
    apiPost<{ ok: boolean; reportId?: string; error?: string }>(
      "/runner/control/pilot-feedback",
      payload
    )
      .then((res) => {
        if (!res.ok || !res.reportId) {
          throw new Error(res.error || "Could not send the report.");
        }
        showToast({ kind: "success", title: `Report sent: ${res.reportId}` });
      })
      .catch((err) => {
        // Trade-off: closing immediately means we lose the form state on
        // failure (the user has to re-type to retry). Failures should be
        // rare (local runner) and the toast surfaces the error message
        // and the report ID so the operator can resubmit if needed.
        showToast({
          kind: "error",
          title: "Couldn't send pilot feedback",
          description: err instanceof Error ? err.message : String(err),
          durationMs: 9000
        });
      })
      .finally(() => stopReportSendSignal());
  }, [canSubmit, type, title, description, expected, privacyAck, screenshots, pathname, resetForm]);

  const openReports = useCallback(async () => {
    setView("reports");
    setReports(null);
    setReportsError(null);
    try {
      const res = await apiGet<{ ok: boolean; reports?: StatusReport[]; configured?: boolean; error?: string }>(
        "/runner/control/pilot-feedback/status"
      );
      if (res.ok && Array.isArray(res.reports)) {
        setReports(res.reports);
      } else if (res.configured === false) {
        setReportsError("Recent reports aren't set up on this install.");
      } else {
        setReportsError(res.error ?? "Couldn't load recent reports.");
      }
    } catch {
      setReportsError("Couldn't load recent reports.");
    }
  }, []);

  if (!open) return null;

  // Close is always allowed: submit itself closes the modal too (issue
  // #383 / R-0030), so there is no in-flight state that needs locking.
  const requestClose = () => {
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-start justify-items-center bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] pt-[10vh] backdrop-blur-md"
      onClick={requestClose}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pilot feedback"
        className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-[18px] border border-hairline bg-paper shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-5 py-[14px]">
          {view === "reports" ? (
            <button
              type="button"
              onClick={() => setView("form")}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
            >
              <ChevronLeft className="h-[15px] w-[15px]" strokeWidth={1.7} />
              Back
            </button>
          ) : (
            <p className="m-0 text-[13px] font-semibold text-ink">Send pilot feedback</p>
          )}
          {view === "form" ? (
            <button
              type="button"
              onClick={() => void openReports()}
              className="text-[12px] font-medium text-ink-3 hover:text-ink"
            >
              Recent reports
            </button>
          ) : null}
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            title="Close (Esc)"
            className="ml-auto grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
        </header>

        {view === "reports" ? (
          <div className="overflow-y-auto px-5 py-4">
            <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-ink-3">
              Your recent reports and where they stand. Screenshots and message content are never
              shown here.
            </p>
            {reports === null && !reportsError ? (
              <p className="font-mono text-[11px] text-ink-3">Loading…</p>
            ) : reportsError ? (
              <p className="text-[12.5px] text-ink-3">{reportsError}</p>
            ) : reports && reports.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No reports yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {(reports ?? []).map((report) => (
                  <li
                    key={report.reportId}
                    className="rounded-row border border-hairline px-3 py-[10px]"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-medium text-ink">{report.title}</span>
                      <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                        {report.reportId}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                      <span>{report.type}</span>
                      <span className="text-ink-2">{report.status}</span>
                      <span>{report.createdAt}</span>
                    </div>
                    {report.note ? (
                      <p className="m-0 mt-1.5 text-[12px] leading-[1.5] text-ink-2">{report.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="overflow-y-auto px-5 py-4">
            {/* Issue #383 / R-0030: the inline error block was removed —
                submit now closes the modal immediately and surfaces the
                outcome via toast. The fallback form URL is still
                referenced from the strategy docs if an operator wants
                to bypass the in-app flow entirely. */}

            <Field label="What kind of report is this?">
              <div className="flex flex-wrap gap-2">
                {PILOT_REPORT_TYPES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setType(option)}
                    aria-pressed={type === option}
                    className={cn(
                      "rounded-pill border px-3 py-[6px] text-[12.5px] transition-colors duration-calm",
                      type === option
                        ? "border-ink bg-ink text-paper"
                        : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2"
                    )}
                  >
                    {PILOT_REPORT_TYPE_LABELS[option]}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Title">
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="A short summary"
                maxLength={200}
                className="w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[14px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
              />
            </Field>

            <Field
              label={type === "bug" ? "What happened?" : "Tell us more"}
              hint="In your own words. Please don't paste private message content."
            >
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder={
                  type === "bug"
                    ? "What were you doing, and what went wrong?"
                    : "What did you notice?"
                }
                className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
              />
            </Field>

            <Field label="What did you expect?" hint="Optional.">
              <textarea
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
                rows={2}
                placeholder="What you thought would happen instead"
                className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
              />
            </Field>

            <Field
              label={screenshots.length > 1 ? "Screenshots" : "Screenshot"}
              hint={`Optional. Up to ${MAX_SCREENSHOTS}. Drag images in, or choose files.`}
            >
              {screenshots.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {screenshots.map((shot) => (
                    <li
                      key={shot.id}
                      className="flex items-center gap-3 rounded-row border border-hairline bg-paper-2/50 p-2"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={shot.dataUrl}
                        alt={`Attached screenshot preview: ${shot.name}`}
                        className="h-[44px] w-[44px] shrink-0 rounded-[6px] object-cover"
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
                        {shot.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeScreenshot(shot.id)}
                        className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {screenshots.length < MAX_SCREENSHOTS ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(false);
                    void acceptFiles(event.dataTransfer.files);
                  }}
                  className={cn(
                    "flex w-full items-center justify-center gap-2 rounded-row border border-dashed py-[14px] text-[12.5px] transition-colors duration-calm",
                    screenshots.length > 0 && "mt-2",
                    dragOver
                      ? "border-hairline-strong bg-paper-2 text-ink"
                      : "border-hairline text-ink-3 hover:border-hairline-strong hover:text-ink-2"
                  )}
                >
                  <ImageUp className="h-[15px] w-[15px]" strokeWidth={1.7} />
                  {screenshots.length > 0
                    ? "Add another image"
                    : "Drag screenshots here, or choose files"}
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ALLOWED_SCREENSHOT_TYPES.join(",")}
                className="hidden"
                onChange={(event) => {
                  void acceptFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              {screenshotError ? (
                <p className="mt-1.5 text-[11.5px] text-risk-overdue">{screenshotError}</p>
              ) : null}
            </Field>

            {screenshots.length > 0 ? (
              <label className="mt-1 flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={privacyAck}
                  onChange={(event) => setPrivacyAck(event.target.checked)}
                  className="mt-[2px] h-[14px] w-[14px] cursor-pointer accent-ink"
                />
                <span className="text-[12px] leading-[1.5] text-ink-2">
                  I understand screenshots may include private messages, so I have checked or
                  blurred anything sensitive.
                </span>
              </label>
            ) : null}

            <div className="mt-4 flex items-center gap-[10px]">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="inline-flex items-center gap-2 rounded-pill bg-ink px-[18px] py-[9px] text-[12.5px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Submit report
              </button>
              <span className="text-[11.5px] leading-[1.45] text-ink-3">
                Goes to the pilot log. No message content is included.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
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
    <div className="mb-4">
      <p className="m-0 text-[12.5px] font-medium text-ink">{label}</p>
      {hint ? <p className="m-0 mt-0.5 text-[11.5px] leading-[1.45] text-ink-3">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
