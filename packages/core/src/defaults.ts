import type { AppSettings } from "./types";

export const defaultSettings: AppSettings = {
  scanIntervalSeconds: 60,
  amberHours: 6,
  redHours: 18,
  headless: false,
  maxMessagesPerThread: 15,
  enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "TIKTOK", "WHATSAPP"],
  demoMode: false,
  recentThreadSweepCount: 30,
  aiProvider: "openai"
};
