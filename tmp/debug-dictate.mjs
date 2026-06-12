import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = "http://localhost:3457";
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--use-fake-ui-for-media-acquisition", "--use-fake-device-for-media-stream"]
});
const ctx = await browser.newContext();
await ctx.grantPermissions(["microphone"], { origin: BASE });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`${BASE}/thread/t-verify-1`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-thread-composer="true"] textarea', { timeout: 60000 });
const btn = page.locator('button[aria-label="Dictate"]');
console.log("dictate buttons:", await btn.count());
console.log("disabled:", await btn.first().isDisabled());
console.log("title:", await btn.first().getAttribute("title"));
await btn.first().click({ force: true });
await page.waitForTimeout(3000);
console.log("morph count:", await page.locator('[data-testid="dictation-morph"]').count());
const err = await page.locator("p.font-mono.text-risk-overdue, p.text-risk-overdue").allTextContents().catch(() => []);
console.log("inline errors:", err);
const gum = await page.evaluate(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return "gum-ok";
  } catch (e) {
    return `gum-fail: ${e?.name} ${e?.message}`;
  }
});
console.log(gum);
await browser.close();
