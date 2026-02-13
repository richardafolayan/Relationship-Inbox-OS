import type { PlatformName, SelectorTestReport } from "@inbox-os/core";
import type { SelectorTestStore } from "../types/runtime";

export function createSelectorTestStore(): SelectorTestStore {
  const reports = new Map<PlatformName, SelectorTestReport>();

  return {
    setReport(report) {
      reports.set(report.platform, report);
    },
    getLatestReport(platform) {
      return reports.get(platform);
    }
  };
}
