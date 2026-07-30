"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ContactRound,
  Download,
  KeyRound,
  MessageSquareText,
  Mic2,
  Settings2,
  Sparkles,
  UserRound
} from "lucide-react";
import { apiGet, apiGetRaw, apiPost, ApiRequestError } from "@/lib/api";
import { APP_NAME, LEGACY_APP_NAME } from "@/lib/branding";
import { WhatsAppConnect } from "@/components/settings/WhatsAppConnect";
import { isIMessageFullDiskAccessProblem } from "@/lib/platform-setup";
import { startPilotTour } from "@/lib/pilot-tour";
import {
  isSetupComplete,
  markSetupComplete,
  onSetupWizardStart
} from "@/lib/setup-wizard";
import type { OperatorProfile, PlatformCard } from "@/lib/types";
import { cn } from "@/lib/utils";

type SetupPlatform =
  | "IMESSAGE"
  | "LINKEDIN"
  | "INSTAGRAM"
  | "WHATSAPP"
  | "GOOGLE_MESSAGES";
type TranscriptionMode = "off" | "standard" | "enhanced";
type Step = "welcome" | "profile" | "sources" | "connect" | "contacts" | "ai" | "transcription" | "review" | "done";

interface SetupPreferences {
  selectedPlatforms: SetupPlatform[];
  aiEnabled: boolean;
  transcriptionMode: TranscriptionMode;
  startedAt: string;
  completedAt: string;
}

interface TranscriptionStatus {
  mode: TranscriptionMode;
  phase: "idle" | "downloading" | "error";
  installedMode: TranscriptionMode;
  modelId: string | null;
  downloadedBytes: number;
  approximateDownloadBytes: number;
  error: string | null;
}

interface ContactHealth {
  contactsLoaded: number;
  addressBookContactCount: number;
  unresolvedImessageHandleCount: number;
  shouldHintEmptyContacts: boolean;
  lastCheckedAt: string;
}

interface SetupStatus {
  preferences: SetupPreferences;
  settings: { enabledPlatforms: string[]; aiEnabled: boolean; automaticUpdates: boolean };
  platforms: Array<{ name: SetupPlatform; status: string; connectedAt: string | null; lastError: string | null }>;
  operatorProfile: OperatorProfile;
  transcription: TranscriptionStatus;
  contacts: ContactHealth | null;
  version: string;
}

interface AiStatus {
  enabled: boolean;
  configuredProviders: string[];
}

const ALL_STEPS: Step[] = ["welcome", "profile", "sources", "connect", "contacts", "ai", "transcription", "review", "done"];

export function SetupWizard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [selected, setSelected] = useState<SetupPlatform[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);

  const load = useCallback(async () => {
    const [setup, ai] = await Promise.all([
      apiGetRaw<SetupStatus>("/runner/data/setup/status"),
      apiGetRaw<AiStatus>("/runner/data/ai-status")
    ]);
    setStatus(setup);
    const availablePlatforms = new Set(setup.platforms.map((platform) => platform.name));
    setSelected(
      setup.preferences.selectedPlatforms.filter((platform) => availablePlatforms.has(platform))
    );
    setAiEnabled(setup.preferences.aiEnabled);
    setAiConfigured(ai.configuredProviders.length > 0);
    return { setup, ai };
  }, []);

  useEffect(() => {
    if (isSetupComplete(window.localStorage)) return;
    let cancelled = false;
    void load().then(({ setup, ai }) => {
      if (cancelled) return;
      if (setup.preferences.completedAt) {
        markSetupComplete(window.localStorage);
        return;
      }
      const existingInstall =
        !setup.preferences.startedAt &&
        (ai.configuredProviders.length > 0 || setup.platforms.some((platform) => platform.status === "CONNECTED"));
      if (existingInstall) {
        markSetupComplete(window.localStorage);
        return;
      }
      setOpen(true);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => onSetupWizardStart(() => {
    void load().catch(() => undefined);
    setStep("welcome");
    setOpen(true);
  }), [load]);

  const steps = useMemo(
    () => ALL_STEPS.filter((item) => item !== "contacts" || selected.includes("IMESSAGE")),
    [selected]
  );
  const index = Math.max(0, steps.indexOf(step));
  const next = () => setStep(steps[Math.min(index + 1, steps.length - 1)]!);
  const back = () => setStep(steps[Math.max(index - 1, 0)]!);

  const savePreferences = useCallback(async (partial: Partial<Pick<SetupPreferences, "selectedPlatforms" | "aiEnabled" | "startedAt" | "completedAt">>) => {
    const result = await apiPost<{ preferences: SetupPreferences }>("/runner/control/setup/preferences", partial);
    setSelected(result.preferences.selectedPlatforms);
    setAiEnabled(result.preferences.aiEnabled);
    setStatus((current) => current ? { ...current, preferences: result.preferences } : current);
    return result.preferences;
  }, []);

  const finish = useCallback(async () => {
    const now = new Date().toISOString();
    await savePreferences({ completedAt: now }).catch(() => undefined);
    await apiPost("/runner/control/operator-profile", { setupCompletedAt: now }).catch(() => undefined);
    markSetupComplete(window.localStorage);
    setOpen(false);
  }, [savePreferences]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label={`Set up ${APP_NAME}`} data-testid="setup-wizard" className="app-main-scroll fixed inset-0 z-[100] overflow-y-auto bg-paper">
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(20px+env(safe-area-inset-top))] sm:px-5 sm:py-12">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-[8px]" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((item, itemIndex) => (
              <span key={item} aria-hidden className={cn("h-[5px] rounded-pill transition-all", itemIndex === index ? "w-7 bg-accent" : itemIndex < index ? "w-3 bg-accent/50" : "w-3 bg-hairline-strong")} />
            ))}
          </div>
          {step !== "done" ? (
            <button type="button" onClick={() => void finish()} className="font-mono text-[11px] text-ink-3 underline underline-offset-2 hover:text-ink">
              Finish later
            </button>
          ) : null}
        </div>

        {step === "welcome" ? (
          <Card icon={<Sparkles />} eyebrow="Welcome" title={`Make ${APP_NAME} yours.`} body={`Choose what you want ${APP_NAME} to help with. You can add, change, or remove anything later in Settings.`}>
            <InfoRows rows={[
              ["Messages", "Choose only the places you actually use."],
              ["AI help", `Optional. ${APP_NAME} still works as a calm reply inbox without it.`],
              ["Voice notes", "Off by default. A local model downloads only if you choose one."]
            ]} />
            <Actions><Primary onClick={() => { void savePreferences({ startedAt: status?.preferences.startedAt || new Date().toISOString() }); next(); }}>Start setup <ArrowRight /></Primary></Actions>
          </Card>
        ) : null}

        {step === "profile" ? <ProfileStep initial={status?.operatorProfile} onBack={back} onNext={next} /> : null}

        {step === "sources" ? (
          <SourcesStep
            selected={selected}
            available={status?.platforms.map((platform) => platform.name) ?? []}
            onChange={setSelected}
            onBack={back}
            onNext={async () => { await savePreferences({ selectedPlatforms: selected }); next(); }}
          />
        ) : null}

        {step === "connect" ? <ConnectStep selected={selected} onBack={back} onNext={next} /> : null}

        {step === "contacts" ? <ContactsStep health={status?.contacts ?? null} onBack={back} onNext={next} /> : null}

        {step === "ai" ? (
          <AiStep enabled={aiEnabled} configured={aiConfigured} onEnabled={async (value) => { setAiEnabled(value); await savePreferences({ aiEnabled: value }); }} onConfigured={() => setAiConfigured(true)} onBack={back} onNext={next} />
        ) : null}

        {step === "transcription" ? <TranscriptionStep initial={status?.transcription} onBack={back} onNext={next} /> : null}

        {step === "review" ? (
          <ReviewStep selected={selected} aiEnabled={aiEnabled} aiConfigured={aiConfigured} automaticUpdates={status?.settings.automaticUpdates !== false} version={status?.version ?? ""} onBack={back} onRefresh={load} onNext={next} />
        ) : null}

        {step === "done" ? (
          <Card icon={<Check />} eyebrow="Ready" title={`${APP_NAME} is ready when you are.`} body="New conversations appear after their first scan. You can rerun this assistant or manage optional parts from Settings at any time.">
            <Actions>
              <Primary onClick={() => { void finish().then(() => router.push("/today")); }}>Go to Today</Primary>
              <Quiet onClick={() => { void finish().then(() => { router.push("/today"); window.setTimeout(() => startPilotTour(), 350); }); }}>Show me with safe demo messages</Quiet>
            </Actions>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ProfileStep({ initial, onBack, onNext }: { initial?: OperatorProfile; onBack: () => void; onNext: () => void }) {
  const [name, setName] = useState(initial?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { onNext(); return; }
    setBusy(true);
    await apiPost("/runner/control/operator-profile", { displayName: name.trim() }).catch(() => undefined);
    window.dispatchEvent(new CustomEvent("operator-profile-saved"));
    setBusy(false);
    onNext();
  };
  return <Card icon={<UserRound />} eyebrow="About you" title={`What should ${APP_NAME} call you?`} body="This name stays in your app and makes the welcome screen feel like yours.">
    <label className="mt-5 block text-[13px] text-ink-2">Your first name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus className="mt-2 block w-full rounded-[8px] border border-hairline bg-paper px-3 py-[10px] text-[14px] text-ink focus:border-hairline-strong focus:outline-none" placeholder="For example, Maya" /></label>
    <Actions><Back onClick={onBack} /><Primary disabled={busy} onClick={() => void save()}>{busy ? "Saving..." : name.trim() ? "Save and continue" : "Skip for now"}</Primary></Actions>
  </Card>;
}

function SourcesStep({ selected, available, onChange, onBack, onNext }: { selected: SetupPlatform[]; available: SetupPlatform[]; onChange: (value: SetupPlatform[]) => void; onBack: () => void; onNext: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const allChoices: Array<[SetupPlatform, string, string]> = [
    ["IMESSAGE", "iMessage", "Messages and Contacts on this Mac"],
    ["GOOGLE_MESSAGES", "Google Messages", "SMS, MMS, and RCS from your Android phone"],
    ["LINKEDIN", "LinkedIn", "Your normal LinkedIn account in Chrome"],
    ["INSTAGRAM", "Instagram", "Your Instagram messages in a dedicated standard Chrome profile"],
    ["WHATSAPP", "WhatsApp", "Link this computer from WhatsApp on your phone"]
  ];
  const choices = allChoices.filter(([platform]) => available.includes(platform));
  const toggle = (platform: SetupPlatform) => onChange(selected.includes(platform) ? selected.filter((item) => item !== platform) : [...selected, platform]);
  return <Card icon={<MessageSquareText />} eyebrow="Message sources" title="Where do you get messages?" body="Select only what you use. Unselected services stay inactive and do not need to be connected.">
    <div className="mt-5 grid gap-3">{choices.map(([value, label, body]) => <button key={value} type="button" aria-pressed={selected.includes(value)} onClick={() => toggle(value)} className={cn("flex items-center gap-3 rounded-[10px] border px-4 py-4 text-left", selected.includes(value) ? "border-accent bg-accent/5" : "border-hairline bg-paper-2/40")}><span className={cn("grid h-5 w-5 place-items-center rounded-[5px] border", selected.includes(value) ? "border-accent bg-accent text-white" : "border-hairline-strong")}>{selected.includes(value) ? <Check className="h-3.5 w-3.5" /> : null}</span><span><span className="block text-[15px] font-medium text-ink">{label}</span><span className="mt-0.5 block text-[12.5px] text-ink-3">{body}</span></span></button>)}</div>
    <Actions><Back onClick={onBack} /><Primary disabled={busy} onClick={() => { setBusy(true); void onNext().finally(() => setBusy(false)); }}>{busy ? "Saving..." : selected.length ? "Set up these sources" : "Continue without messages"}</Primary></Actions>
  </Card>;
}

function ConnectStep({ selected, onBack, onNext }: { selected: SetupPlatform[]; onBack: () => void; onNext: () => void }) {
  const [rows, setRows] = useState<PlatformCard[]>([]);
  const [busy, setBusy] = useState<SetupPlatform | null>(null);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(() => apiGetRaw<PlatformCard[]>("/runner/data/platforms").then(setRows).catch(() => undefined), []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 3000); return () => window.clearInterval(timer); }, [refresh]);
  const act = async (platform: SetupPlatform, path: string, body: unknown) => {
    setBusy(platform); setNotice("");
    try { const result = await apiPost<{ message?: string }>(path, body); setNotice(result.message ?? "Done. Checking the connection now."); await refresh(); }
    catch { setNotice("That did not finish. Follow the instructions below, then try again."); }
    finally { setBusy(null); }
  };
  if (selected.length === 0) return <Card icon={<MessageSquareText />} eyebrow="Messages" title="No message sources selected." body="That is fine. You can add iMessage, Google Messages, LinkedIn, Instagram, or WhatsApp later in Settings."><Actions><Back onClick={onBack} /><Primary onClick={onNext}>Continue</Primary></Actions></Card>;
  const imessage = rows.find((row) => row.platform === "IMESSAGE");
  const googleMessages = rows.find((row) => row.platform === "GOOGLE_MESSAGES");
  const linkedin = rows.find((row) => row.platform === "LINKEDIN");
  const instagram = rows.find((row) => row.platform === "INSTAGRAM");
  const needsAccess = isIMessageFullDiskAccessProblem(imessage);
  return <Card icon={<MessageSquareText />} eyebrow="Connect messages" title="Connect each source you chose." body={`Complete one card at a time. ${APP_NAME} reads conversations into your inbox. Replies only send when you choose. A focus note can send automatically only when you turn it on for that focus window.`}>
    {notice ? <Notice>{notice}</Notice> : null}
    <div className="mt-5 grid gap-3">
      {selected.includes("IMESSAGE") ? <Platform title="iMessage" connected={imessage?.status === "CONNECTED"} body={needsAccess ? `Press Open Mac permission. In Full Disk Access, turn on ${APP_NAME} or ${LEGACY_APP_NAME}. Then quit and reopen ${APP_NAME}.` : "Press Scan iMessage. macOS may ask for permission the first time."} action={needsAccess ? "Open Mac permission" : "Scan iMessage"} busy={busy === "IMESSAGE"} onClick={() => void act("IMESSAGE", needsAccess ? "/runner/control/imessage/full-disk-access" : "/runner/control/scan", needsAccess ? {} : { platform: "IMESSAGE" })} /> : null}
      {selected.includes("GOOGLE_MESSAGES") ? <Platform title="Google Messages" connected={googleMessages?.status === "CONNECTED"} body={`Press Pair Android phone. Sign in to Google Messages in the window, then confirm the matching emoji on your phone if asked. Keep the window open until ${APP_NAME} says connected.`} action="Pair Android phone" busy={busy === "GOOGLE_MESSAGES"} onClick={() => void act("GOOGLE_MESSAGES", "/runner/control/platform/connect", { platform: "GOOGLE_MESSAGES" })} /> : null}
      {selected.includes("LINKEDIN") ? <Platform title="LinkedIn" connected={linkedin?.status === "CONNECTED"} body={`Press Connect LinkedIn. A Chrome window opens. Sign in yourself if asked, then leave the window open until ${APP_NAME} says connected.`} action="Connect LinkedIn" busy={busy === "LINKEDIN"} onClick={() => void act("LINKEDIN", "/runner/control/platform/connect", { platform: "LINKEDIN" })} /> : null}
      {selected.includes("INSTAGRAM") ? <Platform title="Instagram" connected={instagram?.status === "CONNECTED"} body={`Press Connect Instagram. A dedicated standard Chrome window opens. Sign in yourself and complete any security check, then leave it open until ${APP_NAME} says connected.`} action="Connect Instagram" busy={busy === "INSTAGRAM"} onClick={() => void act("INSTAGRAM", "/runner/control/platform/connect", { platform: "INSTAGRAM" })} /> : null}
      {selected.includes("WHATSAPP") ? <div className="rounded-[10px] border border-hairline bg-paper-2/45 p-4"><WhatsAppConnect /><ol className="mb-0 mt-3 pl-5 text-[12.5px] leading-6 text-ink-2"><li>Open WhatsApp on your phone.</li><li>Open Settings, then Linked Devices.</li><li>Press Link a Device and scan the code shown here.</li></ol></div> : null}
    </div>
    <Actions><Back onClick={onBack} /><Primary onClick={onNext}>Continue</Primary><Quiet onClick={onNext}>Finish connections later</Quiet></Actions>
  </Card>;
}

function ContactsStep({ health, onBack, onNext }: { health: ContactHealth | null; onBack: () => void; onNext: () => void }) {
  const [current, setCurrent] = useState(health);
  const [busy, setBusy] = useState(false);
  const recheck = async () => { setBusy(true); const result = await apiPost<{ health: ContactHealth }>("/runner/control/imessage/contacts/resync", {}).catch(() => null); if (result) setCurrent(result.health); setBusy(false); };
  const ready = (current?.addressBookContactCount ?? 0) > 0;
  return <Card icon={<ContactRound />} eyebrow="Contact names" title="Make sure names can show." body={`${APP_NAME} matches iMessage phone numbers and email addresses with the Contacts app on this Mac.`}>
    <Notice>{ready ? `${current!.addressBookContactCount} contact records are available. ${APP_NAME} will use them when it can match a conversation.` : "No Mac contacts were found yet. Your messages still work, but some people may appear as a phone number."}</Notice>
    {!ready ? <ol className="mt-4 pl-5 text-[13px] leading-6 text-ink-2"><li>Open the Contacts app on this Mac.</li><li>If your contacts are on your iPhone, open System Settings, your name, iCloud, then turn on Contacts.</li><li>Wait for names to appear in Contacts, then return here and press Check again.</li></ol> : null}
    <Actions><Back onClick={onBack} /><Primary disabled={busy} onClick={() => void recheck()}>{busy ? "Checking..." : ready ? "Check again" : "Check Contacts again"}</Primary><Quiet onClick={onNext}>{ready ? "Continue" : "Continue for now"}</Quiet></Actions>
  </Card>;
}

function AiStep({ enabled, configured, onEnabled, onConfigured, onBack, onNext }: { enabled: boolean; configured: boolean; onEnabled: (value: boolean) => Promise<void>; onConfigured: () => void; onBack: () => void; onNext: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saveKey = async () => { setBusy(true); setError(""); try { await apiPost("/runner/control/setup/ai-key", { key: key.trim() }); await onEnabled(true); onConfigured(); } catch (err) { const payload = err instanceof ApiRequestError ? err.payload as { error?: string } : undefined; setError(payload?.error ?? "The key could not be checked. Try copying it again."); } finally { setBusy(false); } };
  return <Card icon={<KeyRound />} eyebrow="Optional AI help" title="Would you like summaries and writing help?" body="AI is optional. When it is on, the relevant conversation text is sent to Google Gemini for summaries or help you request. AI suggestions never send on their own.">
    <div className="mt-5 grid gap-3"><Choice selected={!enabled} title="No AI help" body="Keep message organisation and reply tracking. No conversation text is sent to an AI service." onClick={() => void onEnabled(false)} /><Choice selected={enabled} title="Use optional AI help" body="Add a free Gemini key. You can turn this off later." onClick={() => void onEnabled(true)} /></div>
    {enabled ? configured ? <Notice>AI is ready. Your saved Gemini key will be used.</Notice> : <div className="mt-4 rounded-[10px] border border-hairline bg-paper-2/40 p-4"><ol className="m-0 pl-5 text-[13px] leading-6 text-ink-2"><li>Open <a className="underline" target="_blank" rel="noreferrer" href="https://aistudio.google.com/apikey">Google AI Studio</a> and sign in.</li><li>Press Create API key, then Copy.</li><li>Paste the key below. {APP_NAME} checks it and keeps it on this Mac.</li></ol><div className="mt-3 flex gap-2"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} className="min-w-0 flex-1 rounded-[8px] border border-hairline bg-paper px-3 py-2 font-mono text-[13px]" placeholder="Paste Gemini API key" /><Primary disabled={busy || !key.trim()} onClick={() => void saveKey()}>{busy ? "Checking..." : "Check and save"}</Primary></div>{error ? <Notice>{error}</Notice> : null}</div> : null}
    <Actions><Back onClick={onBack} /><Primary onClick={onNext}>{enabled && !configured ? "Set up later" : "Continue"}</Primary></Actions>
  </Card>;
}

function TranscriptionStep({ initial, onBack, onNext }: { initial?: TranscriptionStatus; onBack: () => void; onNext: () => void }) {
  const [status, setStatus] = useState<TranscriptionStatus | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => apiGetRaw<TranscriptionStatus>("/runner/data/setup/transcription").then(setStatus).catch(() => undefined), []);
  useEffect(() => { if (status?.phase !== "downloading") return; const timer = window.setInterval(() => void refresh(), 1500); return () => window.clearInterval(timer); }, [status?.phase, refresh]);
  const choose = async (mode: TranscriptionMode, removeDownloadedModels = false) => { setBusy(true); const nextStatus = await apiPost<TranscriptionStatus>("/runner/control/setup/transcription", { mode, removeDownloadedModels }).catch(() => null); if (nextStatus) setStatus(nextStatus); setBusy(false); };
  const downloading = status?.phase === "downloading";
  return <Card icon={<Mic2 />} eyebrow="Optional voice notes" title="Choose voice transcription." body="Transcription runs on this Mac. Audio does not need to go to an AI company. Models download only when you choose one.">
    <div className="mt-5 grid gap-3"><Choice selected={status?.mode === "off"} title="Off" body="No model download. Voice notes can still be played." onClick={() => void choose("off")} /><Choice selected={status?.mode === "standard"} title="Standard, about 150 MB" body="Good everyday English transcription using the local base model." onClick={() => void choose("standard")} /><Choice selected={status?.mode === "enhanced"} title="Enhanced, about 500 MB" body="Better accuracy using a larger local model. Choose this only if you want it." onClick={() => void choose("enhanced")} /></div>
    {downloading ? <Notice><Download className="mr-2 inline h-4 w-4" />Downloading the chosen model. You can keep this screen open. It turns on only after the download finishes.</Notice> : null}
    {status?.phase === "error" ? <Notice>The download did not finish. Check your internet connection and choose the model again.</Notice> : null}
    {status?.installedMode !== "off" && status?.mode === "off" ? <button type="button" onClick={() => void choose("off", true)} className="mt-4 text-[12.5px] text-ink-2 underline underline-offset-2">Remove the downloaded model from this Mac</button> : null}
    <Actions><Back onClick={onBack} /><Primary disabled={busy || downloading} onClick={onNext}>{downloading ? "Downloading..." : "Continue"}</Primary></Actions>
  </Card>;
}

function ReviewStep({ selected, aiEnabled, aiConfigured, automaticUpdates, version, onBack, onRefresh, onNext }: { selected: SetupPlatform[]; aiEnabled: boolean; aiConfigured: boolean; automaticUpdates: boolean; version: string; onBack: () => void; onRefresh: () => Promise<unknown>; onNext: () => void }) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); const value = await onRefresh().catch(() => null) as { setup?: SetupStatus } | null; if (value?.setup) setSetup(value.setup); setBusy(false); };
  useEffect(() => { void refresh(); }, []);
  const rows = setup?.platforms ?? [];
  return <Card icon={<Settings2 />} eyebrow="Final check" title={`Here is what ${APP_NAME} will use.`} body="Green means ready now. Anything unfinished can be completed later from Settings.">
    <div className="mt-5 divide-y divide-hairline rounded-[10px] border border-hairline bg-paper-2/35">
      {selected.length ? selected.map((platform) => { const connected = rows.some((row) => row.name === platform && row.status === "CONNECTED"); return <Summary key={platform} label={{ IMESSAGE: "iMessage", GOOGLE_MESSAGES: "Google Messages", LINKEDIN: "LinkedIn", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp" }[platform]} value={connected ? "Connected" : "Finish in Settings"} ok={connected} />; }) : <Summary label="Message sources" value="None selected" ok />}
      {selected.includes("IMESSAGE") ? <Summary label="Contact names" value={(setup?.contacts?.addressBookContactCount ?? 0) > 0 ? `${setup!.contacts!.addressBookContactCount} records available` : "Check Contacts later"} ok={(setup?.contacts?.addressBookContactCount ?? 0) > 0} /> : null}
      <Summary label="AI help" value={!aiEnabled ? "Off by choice" : aiConfigured ? "Ready" : "Key still needed"} ok={!aiEnabled || aiConfigured} />
      <Summary label="Voice transcription" value={setup?.transcription.mode === "standard" ? "Standard local model" : setup?.transcription.mode === "enhanced" ? "Enhanced local model" : "Off by choice"} ok={setup?.transcription.phase !== "error"} />
      <Summary label="Automatic updates" value={automaticUpdates ? "On" : "Off"} ok={automaticUpdates} />
      <Summary label="Installed version" value={version || "Current install"} ok />
    </div>
    <p className="mt-4 text-[12.5px] leading-5 text-ink-3">When an update is ready, {APP_NAME} checks automatically. Keep automatic updates on in Settings. If {APP_NAME} asks you to replace the app, download the new installer, open it, and drag {APP_NAME} into Applications again. Your data and choices stay in place.</p>
    <Actions><Back onClick={onBack} /><Primary onClick={onNext}>Finish setup</Primary><Quiet onClick={() => void refresh()}>{busy ? "Checking..." : "Check again"}</Quiet></Actions>
  </Card>;
}

function Card({ icon, eyebrow, title, body, children }: { icon: React.ReactNode; eyebrow: string; title: string; body: string; children?: React.ReactNode }) { return <section className="relative overflow-hidden rounded-card border border-hairline bg-paper p-6 shadow-card sm:p-8"><div className="relative"><p className="m-0 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-accent-ink"><span className="[&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>{eyebrow}</p><h1 className="m-0 mt-3 max-w-[28ch] font-display text-[27px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">{title}</h1><p className="m-0 mt-3 max-w-[62ch] text-[14px] leading-[1.6] text-ink-2">{body}</p>{children}</div></section>; }
function Actions({ children }: { children: React.ReactNode }) { return <div className="mt-6 flex flex-wrap items-center gap-3">{children}</div>; }
function Primary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) { return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-4 py-[9px] text-[13.5px] font-medium text-paper hover:bg-ink-2 disabled:opacity-50 [&>svg]:h-3.5 [&>svg]:w-3.5">{children}</button>; }
function Quiet({ onClick, children }: { onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className="inline-flex items-center rounded-pill border border-hairline px-4 py-[9px] text-[13.5px] font-medium text-ink-2 hover:bg-paper-2">{children}</button>; }
function Back({ onClick }: { onClick: () => void }) { return <Quiet onClick={onClick}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Back</Quiet>; }
function Notice({ children }: { children: React.ReactNode }) { return <p className="m-0 mt-4 rounded-[8px] border border-hairline bg-paper-2/55 px-3 py-2.5 text-[12.5px] leading-5 text-ink-2" aria-live="polite">{children}</p>; }
function InfoRows({ rows }: { rows: Array<[string, string]> }) { return <div className="mt-5 divide-y divide-hairline rounded-[10px] border border-hairline bg-paper-2/35">{rows.map(([label, body]) => <div key={label} className="px-4 py-3"><p className="m-0 text-[13.5px] font-medium text-ink">{label}</p><p className="m-0 mt-0.5 text-[12.5px] text-ink-3">{body}</p></div>)}</div>; }
function Choice({ selected, title, body, onClick }: { selected: boolean; title: string; body: string; onClick: () => void }) { return <button type="button" aria-pressed={selected} onClick={onClick} className={cn("rounded-[10px] border px-4 py-3 text-left", selected ? "border-accent bg-accent/5" : "border-hairline bg-paper-2/35")}><span className="flex items-center gap-2 text-[14px] font-medium text-ink">{selected ? <Check className="h-4 w-4 text-accent" /> : <span className="h-4 w-4 rounded-full border border-hairline-strong" />}{title}</span><span className="mt-1 block pl-6 text-[12.5px] leading-5 text-ink-3">{body}</span></button>; }
function Platform({ title, body, connected, action, busy, onClick }: { title: string; body: string; connected: boolean; action: string; busy: boolean; onClick: () => void }) { return <div className="flex flex-col items-stretch gap-3 rounded-[10px] border border-hairline bg-paper-2/40 p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="m-0 flex items-center gap-2 text-[15px] font-medium text-ink">{title}{connected ? <span className="rounded-pill bg-risk-fresh/15 px-2 py-0.5 font-mono text-[10px] text-risk-fresh">Connected</span> : null}</p><p className="m-0 mt-1 text-[12.5px] leading-5 text-ink-3">{body}</p></div>{!connected ? <div className="self-start sm:self-auto"><Primary disabled={busy} onClick={onClick}>{busy ? "Working..." : action}</Primary></div> : null}</div>; }
function Summary({ label, value, ok }: { label: string; value: string; ok: boolean }) { return <div className="flex items-center justify-between gap-3 px-4 py-3"><span className="text-[13px] text-ink-2">{label}</span><span className={cn("flex items-center gap-1.5 font-mono text-[11px]", ok ? "text-risk-fresh" : "text-ink-3")}>{ok ? <Check className="h-3.5 w-3.5" /> : null}{value}</span></div>; }
