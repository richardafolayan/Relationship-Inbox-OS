"use client";

import { useEffect, useState } from "react";
import { FocusSetupSheet } from "@/components/common/focus/focus-setup-sheet";
import { FocusReviewSheet } from "@/components/common/focus/focus-review-sheet";
import {
  FOCUS_OPEN_REVIEW_EVENT,
  FOCUS_OPEN_SETUP_EVENT,
  useFocusWindow
} from "@/lib/use-focus-window";

// Mounted once in AppShell so the Focus setup + review sheets can be opened
// from anywhere (Today card, top-bar toggle, thread strip, inbox group) via
// the openFocusSetup() / openFocusReview() event dispatchers. A single shared
// useFocusWindow instance keeps the sheets in step with each other.
export function FocusOverlays() {
  const focus = useFocusWindow();
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupInNote, setSetupInNote] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const onSetup = (event: Event) => {
      const detail = (event as CustomEvent<{ editNote?: boolean }>).detail;
      setSetupInNote(!!detail?.editNote);
      setReviewOpen(false);
      setSetupOpen(true);
    };
    const onReview = () => {
      setSetupOpen(false);
      setReviewOpen(true);
    };
    window.addEventListener(FOCUS_OPEN_SETUP_EVENT, onSetup);
    window.addEventListener(FOCUS_OPEN_REVIEW_EVENT, onReview);
    return () => {
      window.removeEventListener(FOCUS_OPEN_SETUP_EVENT, onSetup);
      window.removeEventListener(FOCUS_OPEN_REVIEW_EVENT, onReview);
    };
  }, []);

  return (
    <>
      <FocusSetupSheet
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        focus={focus}
        startInNote={setupInNote}
      />
      <FocusReviewSheet open={reviewOpen} onClose={() => setReviewOpen(false)} focus={focus} />
    </>
  );
}
