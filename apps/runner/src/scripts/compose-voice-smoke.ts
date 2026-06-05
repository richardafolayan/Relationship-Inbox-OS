// Smoke test for composeInVoice.
//
// Hits four common compose scenarios and prints the AI's output. Run
// locally with the same env the runner uses (OPENAI_API_KEY or Z.AI key
// configured). Output can be pasted into the PR description so a reviewer
// can sanity-check the voice match before merging. Note: these scenarios
// pass no operator voice profile, so the AI uses its neutral fallback
// voice — set one via the stub if you want to exercise a configured voice.
//
//   pnpm --filter runner exec tsx src/scripts/compose-voice-smoke.ts

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load env BEFORE importing ai/config — runnerConfig snapshots env at import.
// Walk up from this file until we find an .env (handles both normal
// checkout and .claude/worktrees layouts).
function findEnvUp(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
const here = dirname(fileURLToPath(import.meta.url));
const envPath = findEnvUp(here);
if (envPath) loadDotenv({ path: envPath });
console.log(`[smoke] loaded env from ${envPath}`);

const { createAiService } = await import("../services/ai");
// `AppSettings` lives in @inbox-os/core (it's the public type); `runtime.ts`
// imports it for internal use but doesn't re-export, so TS2694'd here.
type AppSettings = import("@inbox-os/core").AppSettings;
type SettingsStore = import("../types/runtime").SettingsStore;

// Stub settings store so we don't need a DB. createAiService only reads
// `aiProvider` / `glmModel` / `geminiModel` from it; everything else comes
// from runnerConfig (env vars).
const stubSettings: SettingsStore = {
  async getSettings(): Promise<AppSettings> {
    return {
      aiProvider: (process.env.AI_PROVIDER as AppSettings["aiProvider"]) ?? "openai",
      glmModel: process.env.Z_AI_MODEL ?? null,
      geminiModel: process.env.GEMINI_MODEL ?? null
    } as AppSettings;
  },
  async updateSettings() {
    throw new Error("not implemented");
  }
} as unknown as SettingsStore;

interface Scenario {
  label: string;
  intent: string;
  displayName: string;
  voiceSamples: string[];
  threadMessages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
}

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

const scenarios: Scenario[] = [
  {
    label: "1. Reiss-style late reply (the regression that triggered this work)",
    intent: "Acknowledge the gap, thank her for sharing about sales, ask what she's enjoying most about it.",
    displayName: "Reiss",
    voiceSamples: [],
    threadMessages: [
      { direction: "OUT", text: "Hey Reiss, saw you moved into sales recently, how's it going?", timestamp: daysAgo(40) },
      {
        direction: "IN",
        text: "Hey! It's been good actually, steep learning curve but I'm enjoying it. Mostly outbound stuff for a B2B SaaS, lots of cold calls. How have you been?",
        timestamp: daysAgo(35)
      }
    ]
  },
  {
    label: "2. No prior outbound on thread (cold start, only few-shots to lean on)",
    intent: "Thank them for the kind words about the post, ask which part landed for them.",
    displayName: "Sam",
    voiceSamples: [],
    threadMessages: [
      {
        direction: "IN",
        text: "Hey, just wanted to say I really enjoyed your latest post about delegation. Resonated a lot.",
        timestamp: daysAgo(1)
      }
    ]
  },
  {
    label: "3. 60+ day gap (late-reply bucket should fire in the operator's voice, not templated)",
    intent: "Apologise for the delay, say things have been good, ask how he's been.",
    displayName: "James",
    voiceSamples: ["Hey man, yhh sounds good, lets do it", "Appreciate you, will catch you soon"],
    threadMessages: [
      { direction: "OUT", text: "Yeah let's grab a coffee soon man", timestamp: daysAgo(80) },
      {
        direction: "IN",
        text: "Hey, hope you're well! Was thinking about you the other day, how's everything been? Still working on that project?",
        timestamp: daysAgo(70)
      }
    ]
  },
  {
    label: "4. Cold pitch (Example C pattern, ack-only, no follow-up question)",
    intent: "Politely decline, not interested.",
    displayName: "Marcus",
    voiceSamples: [],
    threadMessages: [
      {
        direction: "IN",
        text: "Hey, I help agencies like yours hit page 1 of Google with proven SEO systems. Got 5 mins for a quick call this week?",
        timestamp: daysAgo(2)
      }
    ]
  }
];

async function main() {
  const ai = createAiService(stubSettings);

  for (const s of scenarios) {
    console.log("\n" + "=".repeat(72));
    console.log(s.label);
    console.log("=".repeat(72));
    console.log(`intent: ${s.intent}`);
    const inbound = s.threadMessages.filter((m) => m.direction === "IN").pop();
    if (inbound) console.log(`their last: ${inbound.text}`);
    try {
      const text = await ai.composeInVoice({
        intent: s.intent,
        platform: "LINKEDIN",
        displayName: s.displayName,
        voiceSamples: s.voiceSamples,
        threadMessages: s.threadMessages
      });
      console.log(`\nai output:\n${text}`);
    } catch (err) {
      console.error(`failed: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
