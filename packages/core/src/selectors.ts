import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformName, SelectorRegistry } from "./types";

export type SelectorOverrideStore = Partial<Record<PlatformName, Partial<SelectorRegistry>>>;

const SELECTOR_FILES: Record<PlatformName, string> = {
  LINKEDIN: "linkedin.json",
  INSTAGRAM: "instagram.json",
  TIKTOK: "tiktok.json"
};

export function loadDefaultSelectors(platform: PlatformName, baseDir: string): SelectorRegistry {
  const file = SELECTOR_FILES[platform];
  const raw = readFileSync(join(baseDir, file), "utf-8");
  return JSON.parse(raw) as SelectorRegistry;
}

export function resolveSelectors(
  platform: PlatformName,
  baseDir: string,
  overrides?: SelectorOverrideStore
): SelectorRegistry {
  const defaults = loadDefaultSelectors(platform, baseDir);
  const platformOverrides = overrides?.[platform] ?? {};
  const resolved: SelectorRegistry = {
    ...defaults,
    ...platformOverrides
  };
  if (platform === "LINKEDIN") {
    const legacyThreadListSelector = (resolved.thread_list ?? "").trim();
    if (legacyThreadListSelector === "ul.msg-conversations-container") {
      resolved.thread_list = "ul.msg-conversations-container__conversations-list";
    }
  }
  return resolved;
}
