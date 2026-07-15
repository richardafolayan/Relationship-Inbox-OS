"use client";

import { useEffect } from "react";
import { installUiScaleBridge } from "@/lib/ui-scale";

export function UiScaleBridge(): null {
  useEffect(() => {
    installUiScaleBridge();
  }, []);
  return null;
}
