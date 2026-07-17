"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ImageUp } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { installClientErrorCapture } from "@/lib/client-error-log";
import { showToast } from "@/lib/feedback";
import { signalReportSendStart } from "@/lib/pilot-report-status";
import {
  ALLOWED_SCREENSHOT_TYPES,
  MAX_SCREENSHOTS,
  PILOT_REPORT_TYPES,
  PILOT_REPORT_TYPE_SHORT_LABELS,
  buildPilotReportPayload,
  collectPilotMeta,
  formatPilotReportStatus,
  formatPilotReportSubmittedAt,
  formatPilotReportType,
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

// Pilot feedback + bug report sheet. Mounted once in the app shell; opened
// from anywhere via openPilotFeedback(). Mobile: full-height sheet with
// fixed Cancel/Submit chrome so the keyboard never covers actions. Desktop:
// centred card. Collects only the tester's typed report and any screenshots
// they attach. Never reads or sends message content.
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
  // background (issue #383 / R-0030). Result lands as a success / error
  // toast so the operator can do other things while it sends.

  const [reports, setReports] = useState<StatusReport[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

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

  // Capture uncaught client errors from app start (this modal is mounted once
  // in the shell), so a report submitted right after an error can carry what
  // it was. See R-0077 (#709).
  useEffect(() => installClientErrorCapture(), []);

  // When the last screenshot is removed, the privacy note unmounts; drop the
  // acknowledgement so re-attaching an image asks for it again.
  useEffect(() => {
    if (screenshots.length === 0) setPrivacyAck(false);
  }, [screenshots.length]);

  // Lock background scroll while the sheet is open.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Size the mobile sheet to the visual viewport so a raised keyboard still
  // leaves Cancel and Submit visible above the soft keyboard (issue #911).
  useEffect(() => {
    if (!open) {
      setViewportHeight(null);
      return undefined;
    }
    const vv = window.visualViewport;
    if (!vv) {
      setViewportHeight(window.innerHeight);
      return undefined;
    }
    const sync = () => {
      setViewportHeight(Math.round(vv.height));
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [open]);

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
    // Issue #383 / R-0030: close immediately; send in the background.
    // Issue #421 / R-0047: signal in-flight to the TopStatus ticker.
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

  const requestClose = () => {
    setOpen(false);
  };

  // Visual-viewport height is only applied below the sm breakpoint via the
  // CSS variable. Inline height would override sm:h-auto on desktop.
  const mobileShellStyle =
    viewportHeight != null
      ? ({ ["--pilot-feedback-vvh" as string]: `${viewportHeight}px` } as CSSProperties)
      : undefined;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-stretch bg-paper pt-[env(safe-area-inset-top)] sm:place-items-start sm:justify-items-center sm:bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] sm:pt-[10vh] sm:backdrop-blur-md"
      data-pilot-feedback-overlay="true"
      onClick={requestClose}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        data-pilot-feedback-sheet="true"
        style={mobileShellStyle}
        className="flex h-[var(--pilot-feedback-vvh,100dvh)] w-full flex-col overflow-hidden bg-paper pb-[env(safe-area-inset-bottom)] sm:h-auto sm:max-h-[min(80vh,720px)] sm:w-[min(560px,92vw)] sm:rounded-[18px] sm:border sm:border-hairline sm:pb-0 sm:shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-[12px] sm:px-5 sm:py-[14px]"
          data-pilot-feedback-header="true"
        >
          {view === "reports" ? (
            <button
              type="button"
              onClick={() => setView("form")}
              className="inline-flex min-h-[40px] items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              <ChevronLeft className="h-[15px] w-[15px]" strokeWidth={1.7} />
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={requestClose}
              className="min-h-[40px] text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              Cancel
            </button>
          )}
          <p className="m-0 flex-1 text-center text-[13px] font-semibold text-ink">
            {view === "reports" ? "Recent reports" : "Send feedback"}
          </p>
          {view === "form" ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              data-pilot-feedback-submit="header"
              className="min-h-[40px] text-[13px] font-semibold text-ink disabled:cursor-not-allowed disabled:text-ink-4"
            >
              Submit
            </button>
          ) : (
            <button
              type="button"
              onClick={requestClose}
              className="min-h-[40px] text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              Close
            </button>
          )}
        </header>

        {view === "reports" ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
            data-pilot-feedback-scroll="reports"
          >
            <p className="m-0 mb-3 text-[12.5px] leading-[1.55] text-ink-3">
              Reports the product team has received from this install. Status
              shows where each report stands with the team (Received, Under
              review, Planned, Fixed, or Closed). Private message content and
              screenshots are never shown here.
            </p>
            {reports === null && !reportsError ? (
              <p className="text-[12.5px] text-ink-3">Loading…</p>
            ) : reportsError ? (
              <p className="text-[12.5px] text-ink-3">{reportsError}</p>
            ) : reports && reports.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">No reports yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {(reports ?? []).map((report) => {
                  const statusLabel = formatPilotReportStatus(report.status);
                  const submittedLabel = formatPilotReportSubmittedAt(report.createdAt);
                  const typeLabel = formatPilotReportType(report.type);
                  return (
                    <li
                      key={report.reportId}
                      className="rounded-row border border-hairline px-3 py-[12px]"
                      data-pilot-report-row="true"
                    >
                      <p className="m-0 text-[13.5px] font-medium leading-[1.35] text-ink">
                        {report.title || "Untitled report"}
                      </p>
                      <p className="m-0 mt-1 text-[12px] leading-[1.45] text-ink-3">
                        {submittedLabel}
                        {typeLabel ? ` · ${typeLabel}` : ""}
                      </p>
                      <p className="m-0 mt-1.5 text-[12.5px] font-medium leading-[1.4] text-ink-2">
                        Status: {statusLabel}
                      </p>
                      {report.note ? (
                        <p className="m-0 mt-1.5 text-[12px] leading-[1.5] text-ink-2">
                          {report.note}
                        </p>
                      ) : null}
                      {report.reportId ? (
                        <p className="m-0 mt-2 text-[11px] leading-[1.4] text-ink-4">
                          Ref: {report.reportId}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
              data-pilot-feedback-scroll="form"
            >
              <Field label="What happened?">
                <div
                  className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap"
                  data-pilot-feedback-types="true"
                >
                  {PILOT_REPORT_TYPES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setType(option)}
                      aria-pressed={type === option}
                      className={cn(
                        "rounded-pill border px-3 py-[8px] text-[12.5px] transition-colors duration-calm sm:py-[6px]",
                        type === option
                          ? "border-ink bg-ink text-paper"
                          : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2"
                      )}
                    >
                      {PILOT_REPORT_TYPE_SHORT_LABELS[option]}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Title">
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short summary"
                  maxLength={200}
                  enterKeyHint="next"
                  className="w-full rounded-row border border-hairline bg-paper px-3 py-2.5 text-[16px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong sm:py-2 sm:text-[14px]"
                />
              </Field>

              <Field
                label="Details"
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
                  className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2.5 text-[16px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong sm:py-2 sm:text-[13.5px]"
                />
              </Field>

              <Field label="Expected result" hint="Optional.">
                <textarea
                  value={expected}
                  onChange={(event) => setExpected(event.target.value)}
                  rows={2}
                  placeholder="What you thought would happen instead"
                  className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2.5 text-[16px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong sm:py-2 sm:text-[13.5px]"
                />
              </Field>

              <Field
                label={screenshots.length > 1 ? "Screenshots" : "Screenshot"}
                hint={`Optional. Up to ${MAX_SCREENSHOTS}.`}
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
                          className="shrink-0 text-[12px] font-medium text-ink-3 hover:text-ink"
                        >
                          Remove
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
                    data-pilot-feedback-add-screenshot="true"
                    className={cn(
                      "flex w-full items-center justify-center gap-2 rounded-row border border-dashed py-[14px] text-[12.5px] transition-colors duration-calm",
                      screenshots.length > 0 && "mt-2",
                      dragOver
                        ? "border-hairline-strong bg-paper-2 text-ink"
                        : "border-hairline text-ink-3 hover:border-hairline-strong hover:text-ink-2"
                    )}
                  >
                    <ImageUp className="h-[15px] w-[15px]" strokeWidth={1.7} />
                    <span className="sm:hidden">
                      {screenshots.length > 0
                        ? "Add another from Photos or Files"
                        : "Add from Photos or Files"}
                    </span>
                    <span className="hidden sm:inline">
                      {screenshots.length > 0
                        ? "Add another image"
                        : "Drag screenshots here, or choose files"}
                    </span>
                  </button>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={[...ALLOWED_SCREENSHOT_TYPES, "image/*"].join(",")}
                  className="hidden"
                  data-pilot-feedback-file-input="true"
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

              <div className="mt-2 sm:hidden">
                <button
                  type="button"
                  onClick={() => void openReports()}
                  className="text-[12.5px] font-medium text-ink-3 hover:text-ink"
                >
                  Recent reports
                </button>
              </div>
            </div>

            <footer
              className="flex shrink-0 flex-col gap-2 border-t border-hairline px-4 py-3 sm:flex-row sm:items-center sm:gap-[10px] sm:px-5 sm:py-[14px]"
              data-pilot-feedback-footer="true"
            >
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                data-pilot-feedback-submit="footer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-ink px-[18px] py-[11px] text-[13px] font-medium text-paper transition-colors duration-calm hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:py-[9px] sm:text-[12.5px]"
              >
                Submit report
              </button>
              <div className="flex items-center justify-between gap-3 sm:contents">
                <span className="text-[11.5px] leading-[1.45] text-ink-3">
                  Goes to the pilot team. No message content is included unless you attach it.
                </span>
                <button
                  type="button"
                  onClick={() => void openReports()}
                  className="hidden shrink-0 text-[12px] font-medium text-ink-3 hover:text-ink sm:inline"
                >
                  Recent reports
                </button>
              </div>
            </footer>
          </>
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
