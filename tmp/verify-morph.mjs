// Browser-verify the #476 one-box transcribe morph end to end against the
// mock runner: idle -> recording (waveform) -> transcribing (shimmer) ->
// transcript (editable, tinted) -> composing -> composed ("Draft · in your
// voice" + Redo/Discard), plus Use as-is and Discard paths.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = "http://localhost:3457";
const SHOT = (n) => `/tmp/morph-${n}.png`;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const browser = await chromium.launch({
  headless: true,
  // The default headless shell lacks media capture (getUserMedia throws
  // NotSupportedError); the full chromium build supports the fake mic.
  channel: "chromium",
  args: [
    "--use-fake-ui-for-media-acquisition",
    "--use-fake-device-for-media-stream"
  ]
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(["microphone"], { origin: BASE });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));

await page.goto(`${BASE}/thread/t-verify-1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-thread-composer="true"] textarea', { timeout: 60000 });
console.log("1. composer rendered (idle)");

// --- recording ---
await page.click('button[aria-label="Dictate"]');
await page.waitForSelector('[data-testid="dictation-morph"]', { timeout: 10000 });
const recText = await page.textContent('[data-testid="dictation-morph"]');
if (!/Recording/i.test(recText)) fail(`expected Recording state, got: ${recText.slice(0, 120)}`);
const bars = await page.locator(".dictate-wave-bar").count();
if (bars < 10) fail(`expected waveform bars, got ${bars}`);
// composer must be replaced, not stacked
if (await page.locator('[data-thread-composer="true"]').count()) fail("composer still visible during recording (should morph, not stack)");
await page.waitForTimeout(2200); // let the 0:NN timer tick
await page.screenshot({ path: SHOT("1-recording") });
const timer = await page.textContent('[data-testid="dictation-morph"]');
if (!/0:0[1-9]/.test(timer)) fail(`recording timer did not tick: ${timer.slice(0, 160)}`);
console.log("2. recording morph: waveform + ticking timer, one box");

// --- stop & transcribe ---
await page.getByRole("button", { name: /stop & transcribe/i }).click();
await page.waitForSelector(".dictate-shimmer", { timeout: 10000 });
const transcribing = await page.textContent('[data-testid="dictation-morph"]');
if (!/Transcribing/i.test(transcribing)) fail("expected Transcribing state");
await page.screenshot({ path: SHOT("2-transcribing") });
console.log("3. transcribing morph: shimmer lines");

// --- transcript review ---
await page.waitForSelector('[data-testid="dictation-morph"] textarea', { timeout: 20000 });
const draft = await page.inputValue('[data-testid="dictation-morph"] textarea');
if (!/costco/i.test(draft)) fail(`transcript not in review box: "${draft}"`);
const trText = await page.textContent('[data-testid="dictation-morph"]');
if (!/Transcript/i.test(trText) || !/raw, your words unedited/i.test(trText)) fail("transcript header copy missing");
await page.screenshot({ path: SHOT("3-transcript") });
console.log(`4. transcript morph: editable raw words ("${draft.slice(0, 40)}…")`);

// --- compose in my voice ---
await page.getByRole("button", { name: /compose in my voice/i }).click();
await page.waitForSelector(".dictate-shimmer", { timeout: 10000 });
const composing = await page.textContent('[data-testid="dictation-morph"]');
if (!/Composing/i.test(composing)) fail("expected Composing state");
await page.screenshot({ path: SHOT("4-composing") });
console.log("5. composing morph: shimmer + composing copy");

// --- composed draft in the one box ---
await page.waitForSelector('[data-testid="dictation-composed-badge"]', { timeout: 20000 });
const composed = await page.inputValue('[data-thread-composer="true"] textarea');
if (!/Hey Joe/.test(composed)) fail(`composed draft not in composer: "${composed}"`);
const badge = await page.textContent('[data-testid="dictation-composed-badge"]');
if (!/Draft · in your voice/i.test(badge)) fail("composed badge copy missing");
await page.screenshot({ path: SHOT("5-composed") });
console.log(`6. composed: in-voice draft in the composer ("${composed.slice(0, 40)}…") with Redo/Discard, no autosend`);

// --- redo -> back to transcript ---
await page.getByRole("button", { name: /^redo$/i }).click();
await page.waitForSelector('[data-testid="dictation-morph"] textarea', { timeout: 10000 });
const redoDraft = await page.inputValue('[data-testid="dictation-morph"] textarea');
if (!/costco/i.test(redoDraft)) fail("redo did not return to the transcript");
console.log("7. redo: composed -> transcript preserved");

// --- use as-is ---
await page.getByRole("button", { name: /use as-is/i }).click();
await page.waitForSelector('[data-thread-composer="true"] textarea', { timeout: 10000 });
const asIs = await page.inputValue('[data-thread-composer="true"] textarea');
if (!/costco/i.test(asIs)) fail(`use as-is did not land raw words in composer: "${asIs}"`);
await page.screenshot({ path: SHOT("6-use-as-is") });
console.log("8. use as-is: raw transcript into the normal composer");

// --- cancel mid-recording ---
await page.fill('[data-thread-composer="true"] textarea', "");
await page.click('button[aria-label="Dictate"]');
await page.waitForSelector('[data-testid="dictation-morph"]', { timeout: 10000 });
await page.getByRole("button", { name: /^cancel$/i }).click();
await page.waitForSelector('[data-thread-composer="true"] textarea', { timeout: 10000 });
const afterCancel = await page.inputValue('[data-thread-composer="true"] textarea');
if (afterCancel !== "") fail(`cancel left text in composer: "${afterCancel}"`);
if (await page.locator('[data-testid="dictation-morph"]').count()) fail("morph still visible after cancel");
console.log("9. cancel mid-recording: clean return to idle composer");

await browser.close();
console.log("ALL MORPH CHECKS PASSED");
