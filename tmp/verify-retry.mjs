// #679 retry path through the #476 morph: a transient transcription failure
// keeps the clip in memory and shows the inline banner; "Try again" resubmits
// the SAME clip and the morph resumes into the transcript step.
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

// 503 → banner with Try again, composer back (morph gone), clip retained.
const retryBtn = page.getByRole("button", { name: /try again/i });
await retryBtn.waitFor({ timeout: 20000 });
if (await page.locator('[data-testid="dictation-morph"]').count())
  fail("morph stuck visible after transient failure");
console.log("transient failure: inline retry banner shown, morph settled to idle");

await retryBtn.click();
// The same clip resubmits and the full-drafts transcript step appears.
await page.waitForSelector('[data-testid="dictation-morph"] textarea', { timeout: 20000 });
const draft = await page.inputValue('[data-testid="dictation-morph"] textarea');
if (!/costco/i.test(draft)) fail(`retried clip did not produce transcript: "${draft}"`);
console.log("try again: same clip resubmitted, transcript review step reached");
await browser.close();
console.log("RETRY CHECK PASSED");
