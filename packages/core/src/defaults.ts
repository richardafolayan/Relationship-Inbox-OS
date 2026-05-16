import type { AppSettings } from "./types";

export const defaultSettings: AppSettings = {
  scanIntervalSeconds: 60,
  amberHours: 6,
  redHours: 18,
  // Headless by default: scans run unattended without a Chrome window
  // stealing focus. The dashboard Settings "Headless browser" toggle
  // flips this at runtime when you want to watch/debug a live run.
  headless: true,
  maxMessagesPerThread: 15,
  enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE", "WHATSAPP"],
  demoMode: false,
  recentThreadSweepCount: 30,
  aiProvider: "openai"
};
