"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { APP_NAME } from "@/lib/branding";

interface PhoneAccessInfo {
  available: boolean;
  dictationReady?: boolean;
  fallbackUrl?: string;
  qrDataUrl?: string;
  secure?: boolean;
  url?: string;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy was not available.");
  } finally {
    input.remove();
  }
}

export function PhoneAccess() {
  const [info, setInfo] = useState<PhoneAccessInfo | null>(null);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  useEffect(() => {
    let active = true;
    void fetch("/api/phone-access", { cache: "no-store" })
      .then((response) => response.json() as Promise<PhoneAccessInfo>)
      .then((next) => { if (active) setInfo(next); })
      .catch(() => { if (active) setInfo({ available: false }); });
    return () => { active = false; };
  }, []);

  const copyAddress = async () => {
    if (!info?.url || status === "copying") return;
    setStatus("copying");
    try {
      await copyText(info.url);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section id="phone" className="scroll-mt-24 rounded-card border border-hairline bg-paper px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-[58ch]">
          <p className="m-0 text-[16px] font-medium text-ink">Use {APP_NAME} on your phone</p>
          <p className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-3">
            Open {APP_NAME} from Applications, then use this private link on your phone. Keep {APP_NAME} open on this computer.
          </p>
          {info === null ? (
            <p className="mt-3 font-mono text-[11px] text-ink-3" aria-live="polite">Finding your private address...</p>
          ) : info.available && info.url ? (
            <>
              <p className="mt-3 break-all rounded-[8px] bg-paper-2 px-3 py-2 font-mono text-[11px] leading-5 text-ink-2">
                {info.url}
              </p>
              {info.dictationReady ? (
                <p className="mt-3 rounded-[10px] border border-hairline bg-paper-2 px-3 py-2 text-[12px] leading-5 text-ink-2">
                  Full dictation is ready. For recording that continues while you switch apps or lock the screen, open this HTTPS address in the Tovi iPhone app. Safari stops safely and preserves the audio captured so far when Tovi leaves the screen.
                </p>
              ) : (
                <div className="mt-3 rounded-[10px] border border-hairline bg-paper-2 px-3 py-2 text-[12px] leading-5 text-ink-2">
                  <p className="m-0 font-medium text-ink">This Wi-Fi link cannot use the iPhone microphone.</p>
                  <p className="m-0 mt-1">
                    To enable full dictation, install and connect Tailscale on this Mac and your iPhone, sign both into the same private network, enable HTTPS in Tailscale, then quit and reopen {APP_NAME}.
                  </p>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  disabled={status === "copying"}
                  className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[8px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "copying" ? "Copying..." : status === "copied" ? "Address copied" : "Copy private address"}
                </button>
                <span className="text-[11px] text-ink-3" aria-live="polite">
                  {status === "error"
                    ? "Couldn’t copy. Select the address above."
                    : info.secure
                      ? "The HTTPS link is private to your Tailscale network and contains your access key. Do not share it."
                      : "Reading and typing work on this link, but full dictation needs the HTTPS setup above."}
                </span>
              </div>
            </>
          ) : (
            <p className="mt-3 text-[12px] leading-5 text-ink-3" aria-live="polite">
              Connect this computer to a private Wi-Fi network, then quit and reopen {APP_NAME}.
            </p>
          )}
        </div>
        {info?.available && info.qrDataUrl ? (
          <div className="shrink-0 rounded-[12px] bg-white p-2">
            <Image
              src={info.qrDataUrl}
              alt="QR code for private phone access"
              width={144}
              height={144}
              unoptimized
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
