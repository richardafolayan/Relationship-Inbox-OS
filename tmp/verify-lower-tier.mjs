// Lower-tier dictation: no transcript review step — the raw transcript is
// appended straight into the composer (pre-#476 behaviour preserved).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = "http://localhost:3457";
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--use-fake-ui-for-media-acquisition", "--use-fake-device-for-media-stream"]
});
const ctx = await browser.newContext();
await ctx.grantPermissions(["microphone"], { origin: BASE });
const page = await ctx.newPage();
await page.goto(`${BASE}/thread/t-verify-1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-thread-composer="true"] textarea', { timeout: 60000 });

await page.click('button[aria-label="Dictate"]');
await page.waitForSelector('[data-testid="dictation-morph"]', { timeout: 10000 });
await page.waitForTimeout(800);
await page.getByRole("button", { name: /stop & transcribe/i }).click();

// Raw words must land in the normal composer, with NO transcript review step.
await page.waitForFunction(
  () => {
    const ta = document.querySelector('[data-thread-composer="true"] textarea');
    return ta && /costco/i.test(ta.value);
  },
  { timeout: 20000 }
);
if (await page.locator('[data-testid="dictation-morph"]').count())
  fail("morph/review step rendered on a lower tier");
const composed = await page.inputValue('[data-thread-composer="true"] textarea');
console.log(`lower tier: raw transcript appended to composer ("${composed.slice(0, 40)}…"), no review step`);
await browser.close();
console.log("LOWER-TIER CHECK PASSED");
