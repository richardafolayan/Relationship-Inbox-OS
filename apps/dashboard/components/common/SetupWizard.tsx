"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, KeyRound, MessageSquareText, Sparkles } from "lucide-react";
import { apiGet, apiPost, ApiRequestError } from "@/lib/api";
import { WhatsAppConnect } from "@/components/settings/WhatsAppConnect";
import { isIMessageFullDiskAccessProblem } from "@/lib/platform-setup";
import {
  isSetupComplete,
  markSetupComplete,
  onSetupWizardStart,
  resolveSetupGate
} from "@/lib/setup-wizard";
import type { PlatformCard } from "@/lib/types";
import { cn } from "@/lib/utils";

// First-run setup wizard (#845, pilot R-0109). A full-screen overlay shown
// before Today when the install has neither an AI key nor any connected
// platform. Three steps: welcome, AI key, connect messages, then done.
// Every step is skippable and the whole wizard can be dismissed at any
// point; Settings > Setup has a "Run setup assistant" button to reopen it.

interface AiStatus {
  activeProvider: string;
  activeModel: string;
  configuredProviders: string[];
  activeProviderConfigured: boolean;
}

type WizardStep = "welcome" | "ai" | "messages" | "done";
const STEP_ORDER: WizardStep[] = ["welcome", "ai", "messages", "done"];

export function SetupWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>("welcome");
  const [aiConfigured, setAiConfigured] = useState(false);
  const router = useRouter();

  // First-run gate: evaluated once per app open, and only until the
  // complete flag lands in localStorage. Unknown runner state never shows
  // the wizard; an already-set-up install is auto-marked complete so it
  // never sees this again (upgrades included).
  useEffect(() => {
    const storage = window.localStorage;
    if (isSetupComplete(storage)) return;
    let cancelled = false;
    void (async () => {
      const [ai, platforms] = await Promise.all([
        apiGet<AiStatus>("/runner/data/ai-status").catch(() => null),
        apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => null)
      ]);
      if (cancelled) return;
      const decision = resolveSetupGate({
        storedComplete: isSetupComplete(storage),
        aiConfigured: ai ? ai.configuredProviders.length > 0 : null,
        anyPlatformConnected: platforms
          ? platforms.some((row) => row.status === "CONNECTED")
          : null
      });
      if (decision === "auto-complete") {
        markSetupComplete(storage);
        return;
      }
      if (decision === "show") {
        setAiConfigured(ai ? ai.configuredProviders.length > 0 : false);
        setStep("welcome");
        setOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Settings > Setup "Run setup assistant" reopens the wizard on demand.
  useEffect(
    () =>
      onSetupWizardStart(() => {
        void apiGet<AiStatus>("/runner/data/ai-status")
          .then((ai) => setAiConfigured(ai.configuredProviders.length > 0))
          .catch(() => setAiConfigured(false));
        setStep("welcome");
        setOpen(true);
      }),
    []
  );

  const finish = useCallback(() => {
    markSetupComplete(window.localStorage);
    setOpen(false);
  }, []);

  const goToToday = useCallback(() => {
    finish();
    router.push("/today");
  }, [finish, router]);

  if (!open) return null;

  const stepIndex = STEP_ORDER.indexOf(step);
  const next = () => setStep(STEP_ORDER[Math.min(stepIndex + 1, STEP_ORDER.length - 1)]!);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="First time setup"
      data-testid="setup-wizard"
      className="fixed inset-0 z-[100] overflow-y-auto bg-paper"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col px-5 py-8 sm:py-12">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-[10px]" aria-label={`Step ${stepIndex + 1} of ${STEP_ORDER.length}`}>
            {STEP_ORDER.map((s, i) => (
              <span
                key={s}
                aria-hidden
                className={cn(
                  "h-[5px] rounded-pill transition-all duration-calm",
                  i === stepIndex ? "w-7 bg-accent" : i < stepIndex ? "w-3 bg-accent/50" : "w-3 bg-hairline-strong"
                )}
              />
            ))}
          </div>
          {step !== "done" ? (
            <button
              type="button"
              onClick={finish}
              className="font-mono text-[11px] text-ink-3 underline decoration-hairline-strong underline-offset-2 transition-colors duration-calm hover:text-ink"
            >
              Skip setup
            </button>
          ) : null}
        </div>

        {step === "welcome" ? (
          <WizardCard
            icon={<Sparkles className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />}
            eyebrow="Welcome"
            title="Let's set up Tovi."
            body="Tovi shows who is waiting on a reply, what they said, and what you still need to address. Before it can do that, it needs two things: a free AI key and access to your messages. This takes a few minutes and you can skip any step."
          >
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <PrimaryButton onClick={next}>
                Start setup
                <ArrowRight className="ml-[6px] h-[14px] w-[14px]" strokeWidth={2} aria-hidden />
              </PrimaryButton>
              <QuietButton onClick={finish}>Do this later</QuietButton>
            </div>
          </WizardCard>
        ) : null}

        {step === "ai" ? (
          <AiKeyStep alreadyConfigured={aiConfigured} onSaved={() => setAiConfigured(true)} onNext={next} />
        ) : null}

        {step === "messages" ? <MessagesStep onNext={next} /> : null}

        {step === "done" ? (
          <WizardCard
            icon={<Check className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />}
            eyebrow="All set"
            title="You're ready."
            body="Today will fill up as scans find conversations that need you. There is a short walkthrough waiting on the Today page, and you can teach Tovi your reply style any time in Settings under Reply style."
          >
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <PrimaryButton onClick={goToToday}>Go to Today</PrimaryButton>
            </div>
          </WizardCard>
        ) : null}
      </div>
    </div>
  );
}

function AiKeyStep({
  alreadyConfigured,
  onSaved,
  onNext
}: {
  alreadyConfigured: boolean;
  onSaved: () => void;
  onNext: () => void;
}) {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<"idle" | "checking" | "saved" | "error">(
    alreadyConfigured ? "saved" : "idle"
  );
  const [error, setError] = useState("");

  const save = async () => {
    if (status === "checking") return;
    setStatus("checking");
    setError("");
    try {
      await apiPost("/runner/control/setup/ai-key", { key: key.trim() });
      setStatus("saved");
      onSaved();
    } catch (err) {
      setStatus("error");
      const payload = err instanceof ApiRequestError ? err.payload : undefined;
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Couldn't save the key. Is the app running?";
      setError(message);
    }
  };

  return (
    <WizardCard
      icon={<KeyRound className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />}
      eyebrow="Step 1 of 2"
      title="Add your free AI key."
      body="Tovi uses Google's Gemini service for summaries and optional writing help. To do that, it sends the relevant conversation text to Google. Tovi never sends a reply to another person unless you press send."
    >
      {status === "saved" ? (
        <p className="m-0 mt-5 flex items-center gap-2 text-[13.5px] text-ink" aria-live="polite">
          <Check className="h-[15px] w-[15px] text-risk-fresh" strokeWidth={2} aria-hidden />
          AI is set up. Summaries and drafts will work.
        </p>
      ) : (
        <>
          <ol className="m-0 mt-5 flex list-decimal flex-col gap-[7px] pl-[18px] text-[13.5px] leading-[1.55] text-ink-2">
            <li>
              Open{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-ink underline decoration-hairline-strong underline-offset-2 hover:decoration-ink"
              >
                aistudio.google.com/apikey
              </a>{" "}
              and sign in with any Google account.
            </li>
            <li>If a key is already shown, press Copy. Otherwise, press Create API key, follow the short Google dialog, then copy the new key.</li>
            <li>Paste it below. The key stays on this Mac.</li>
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && key.trim()) void save();
              }}
              placeholder="Paste your API key"
              autoComplete="off"
              spellCheck={false}
              aria-label="Gemini API key"
              className="min-w-0 flex-1 rounded-[8px] border border-hairline bg-paper px-3 py-[9px] font-mono text-[13px] text-ink placeholder:text-ink-3 focus:border-hairline-strong focus:outline-none"
            />
            <PrimaryButton onClick={() => void save()} disabled={status === "checking" || !key.trim()}>
              {status === "checking" ? "Checking..." : "Save key"}
            </PrimaryButton>
          </div>
          {status === "error" ? (
            <p
              className="m-0 mt-3 rounded-row border border-hairline bg-paper-2/60 px-3 py-2 text-[12.5px] leading-[1.45] text-ink-2"
              aria-live="polite"
            >
              {error}
            </p>
          ) : null}
        </>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {status === "saved" ? (
          <PrimaryButton onClick={onNext}>
            Continue
            <ArrowRight className="ml-[6px] h-[14px] w-[14px]" strokeWidth={2} aria-hidden />
          </PrimaryButton>
        ) : (
          <QuietButton onClick={onNext}>Do this later</QuietButton>
        )}
      </div>
    </WizardCard>
  );
}

function MessagesStep({ onNext }: { onNext: () => void }) {
  const [rows, setRows] = useState<PlatformCard[]>([]);
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [busy, setBusy] = useState<PlatformCard["platform"] | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [data, whatsapp] = await Promise.all([
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => null),
      // WhatsApp is opt-in at the runner level; only offer it in the wizard
      // when the operator has turned it on, so the step doesn't show an
      // empty card for the common install where WhatsApp is off.
      apiGet<{ enabled?: boolean }>("/runner/data/whatsapp/status").catch(() => null)
    ]);
    if (data) setRows(data);
    if (whatsapp) setWhatsappEnabled(whatsapp.enabled === true);
  }, []);

  // Poll while this step is on screen so a connect completed in another
  // window (LinkedIn sign-in, WhatsApp QR scan) flips the card live.
  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => void refresh(), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const act = async (platform: PlatformCard["platform"], path: string, body: unknown) => {
    if (busy) return;
    setBusy(platform);
    setError("");
    setNotice("");
    try {
      const result = await apiPost<{ message?: string }>(path, body);
      if (result?.message) setNotice(result.message);
      await refresh();
    } catch {
      setError("That didn't work. Is the app running?");
    } finally {
      setBusy(null);
    }
  };

  const imessage = rows.find((row) => row.platform === "IMESSAGE");
  const linkedin = rows.find((row) => row.platform === "LINKEDIN");
  const imessageNeedsAccess = isIMessageFullDiskAccessProblem(imessage);
  const anyConnected = rows.some((row) => row.status === "CONNECTED");

  return (
    <WizardCard
      icon={<MessageSquareText className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />}
      eyebrow="Step 2 of 2"
      title="Connect your messages."
      body="Connect at least one place you get messages. Tovi only reads; you still write and send every reply yourself."
    >
      {error ? (
        <p className="m-0 mt-4 rounded-row border border-hairline bg-paper-2/60 px-3 py-2 text-[12.5px] leading-[1.45] text-ink-2">
          {error}
        </p>
      ) : null}
      {notice ? <p className="m-0 mt-4 font-mono text-[11px] text-risk-fresh">{notice}</p> : null}
      <div className="mt-5 grid gap-3">
        <WizardPlatformCard
          title="iMessage"
          body={
            imessageNeedsAccess
              ? "Press Open Full Disk Access, turn on Relationship Inbox OS, then quit and reopen Tovi. This is a one-time Mac permission."
              : "Reads the Messages app on this Mac."
          }
          connected={imessage?.status === "CONNECTED"}
          actionLabel={imessageNeedsAccess ? "Open Full Disk Access" : "Scan iMessage"}
          busy={busy === "IMESSAGE"}
          onAction={() =>
            void act(
              "IMESSAGE",
              imessageNeedsAccess
                ? "/runner/control/imessage/full-disk-access"
                : "/runner/control/scan",
              imessageNeedsAccess ? {} : { platform: "IMESSAGE" }
            )
          }
        />
        <WizardPlatformCard
          title="LinkedIn"
          body="Uses your normal Chrome session. Sign into LinkedIn in Chrome first."
          connected={linkedin?.status === "CONNECTED"}
          actionLabel={linkedin?.status === "CONNECTED" ? "Connected" : "Connect LinkedIn"}
          busy={busy === "LINKEDIN"}
          onAction={() =>
            void act("LINKEDIN", "/runner/control/platform/connect", { platform: "LINKEDIN" })
          }
        />
        {whatsappEnabled ? (
          <div className="rounded-[10px] border border-hairline bg-paper-2/45 px-4 py-4">
            <WhatsAppConnect />
          </div>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {anyConnected ? (
          <PrimaryButton onClick={onNext}>
            Continue
            <ArrowRight className="ml-[6px] h-[14px] w-[14px]" strokeWidth={2} aria-hidden />
          </PrimaryButton>
        ) : (
          <QuietButton onClick={onNext}>Do this later</QuietButton>
        )}
      </div>
    </WizardCard>
  );
}

function WizardPlatformCard({
  title,
  body,
  connected,
  actionLabel,
  busy,
  onAction
}: {
  title: string;
  body: string;
  connected?: boolean;
  actionLabel: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-hairline bg-paper-2/45 px-4 py-4">
      <div className="min-w-0 flex-1">
        <p className="m-0 flex items-center gap-2 text-[15.5px] font-medium text-ink">
          {title}
          {connected ? (
            <span className="rounded-pill bg-risk-fresh/15 px-2 py-[2px] font-mono text-[10.5px] text-risk-fresh">
              Connected
            </span>
          ) : null}
        </p>
        <p className="m-0 mt-[3px] text-[13px] leading-[1.45] text-ink-3" style={{ textWrap: "pretty" }}>
          {body}
        </p>
      </div>
      {!connected ? (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className="inline-flex shrink-0 items-center rounded-pill bg-ink px-3 py-[7px] text-[12.5px] font-medium text-paper hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Working..." : actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function WizardCard({
  icon,
  eyebrow,
  title,
  body,
  children
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden rounded-card border border-hairline bg-paper p-6 shadow-card sm:p-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 100% 0%, color-mix(in oklch, var(--accent) 8%, transparent), transparent 55%)"
        }}
      />
      <div className="relative">
        <p className="m-0 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-ink">
          {icon}
          {eyebrow}
        </p>
        <h1 className="m-0 mt-3 max-w-[26ch] font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
          {title}
        </h1>
        <p className="m-0 mt-3 max-w-[58ch] text-[14px] leading-[1.6] text-ink-2" style={{ textWrap: "pretty" }}>
          {body}
        </p>
        {children}
      </div>
    </section>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center rounded-pill bg-ink px-4 py-[9px] text-[13.5px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function QuietButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center rounded-pill border border-hairline px-4 py-[9px] text-[13.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
    >
      {children}
    </button>
  );
}
