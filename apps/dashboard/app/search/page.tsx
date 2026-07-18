"use client";

import { Suspense } from "react";
import { MobileSearchScreen } from "@/components/layout/mobile-search";

// Phone Search is a real route so Back/Cancel and the dock can treat it like
// any other app screen. Desktop still uses the ⌘K command palette.
export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 items-center justify-center bg-paper px-4">
          <span className="font-mono text-[12px] text-ink-3">Opening Search...</span>
        </div>
      }
    >
      <MobileSearchScreen />
    </Suspense>
  );
}
