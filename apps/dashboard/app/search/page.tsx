"use client";

import { MobileSearchScreen } from "@/components/layout/mobile-search";

// Phone Search is a real route so Back/Cancel and the dock can treat it like
// any other app screen. Desktop still uses the ⌘K command palette.
export default function SearchPage() {
  return <MobileSearchScreen />;
}
