"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { ImessageContactHealth } from "@/lib/types";

// Issue #676: when iMessage names show as bare phone numbers, the cause is
// often that THIS Mac's Contacts app is empty (the contacts live only on the
// person's iPhone and were never synced). The app can't invent names that
// aren't on the Mac, so instead of looking broken it explains why and how to
// fix it. Calm, single-line, dismissible, and it only appears when the runner
// confirms the address book is empty AND iMessage threads are still stuck on
// raw handles.

const DISMISS_KEY = "rios:mac-contacts-hint-dismissed";

export function MacContactsHint() {
  const [health, setHealth] = useState<ImessageContactHealth | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until we read storage
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
    let cancelled = false;
    const load = () => {
      void apiGet<ImessageContactHealth | null>("/runner/data/imessage-contact-health")
        .then((res) => {
          if (!cancelled) setHealth(res);
        })
        .catch(() => {
          // Older runner without the endpoint, or a transient failure: stay
          // hidden rather than guess.
          if (!cancelled) setHealth(null);
        });
    };
    load();
    const onResync = () => load();
    window.addEventListener("runner-resync", onResync);
    return () => {
      cancelled = true;
      window.removeEventListener("runner-resync", onResync);
    };
  }, []);

  if (dismissed || !health?.shouldHintEmptyContacts) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Private mode / storage disabled: dismiss for this session only.
    }
  };

  return (
    <div className="mb-6 flex flex-col gap-2 rounded-row border border-hairline bg-paper-2 px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] translate-y-[-1px] rounded-full bg-risk-overdue align-middle" />
          Some iMessage chats show a phone number because this Mac has no saved contacts.{" "}
          <button
            type="button"
            onClick={() => setShowSteps((v) => !v)}
            className="text-accent-ink underline-offset-2 hover:underline"
          >
            {showSteps ? "Hide steps" : "How to fix"}
          </button>
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 shrink-0 rounded-[6px] p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>
      {showSteps ? (
        <ol className="ml-[14px] list-decimal space-y-1 text-[13px] text-ink-2">
          <li>
            On this Mac, open <span className="text-ink">System Settings → [your name] → iCloud</span>, then
            turn on <span className="text-ink">Contacts</span> so your iPhone contacts sync here.
          </li>
          <li>
            Open the <span className="text-ink">Contacts</span> app and wait for your contacts to appear.
          </li>
          <li>
            Back here, run a scan and names replace the numbers automatically. No export needed.
          </li>
        </ol>
      ) : null}
    </div>
  );
}
