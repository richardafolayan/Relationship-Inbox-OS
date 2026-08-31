import type { AppSettings } from "./types";

export const defaultSettings: AppSettings = {
  scanIntervalSeconds: 60,
  automaticUpdates: true,
  amberHours: 6,
  redHours: 18,
  // Headful by default ON PURPOSE. Headless is one of the strongest bot
  // signals in browser fingerprinting (GPU/SwiftShader render path, font
  // metrics, AudioContext, missing window-chrome dimensions) and Patchright
  // cannot patch those. The "Chrome window pops up every 8-13min" UX
  // problem is instead solved by launching the real headful Chrome
  // OFFSCREEN (--window-position far off the desktop) — no visual
  // disruption, no fingerprint penalty. The Settings toggle can still
  // force true headless for CI/debug, but it must never be the default.
  headless: false,
  maxMessagesPerThread: 15,
  enabledPlatforms: [],
  aiEnabled: false,
  demoMode: false,
  presenterDemoMode: "off",
  presenterReadOnly: false,
  recentThreadSweepCount: 30,
  aiProvider: "openai"
};
