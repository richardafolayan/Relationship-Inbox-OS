import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "patchright";

const baseUrl = process.env.MOBILE_AUDIT_BASE_URL ?? "http://127.0.0.1:3110";
const insecurePhoneBaseUrl = process.env.MOBILE_AUDIT_INSECURE_BASE_URL;
const insecurePhoneConnectUrl = process.env.MOBILE_AUDIT_INSECURE_CONNECT_URL;
const threadId = process.env.MOBILE_AUDIT_THREAD_ID;
if (!threadId) throw new Error("MOBILE_AUDIT_THREAD_ID is required");

const outputDir = resolve(process.cwd(), ".mobile-audit");
await mkdir(outputDir, { recursive: true });

const routes = [
  ["home", "/"],
  ["today", "/today"],
  ["inbox", "/inbox"],
  ["archived", "/archived"],
  ["thread", `/thread/${threadId}`],
  ["settings", "/settings"],
  ["platforms", "/platforms"],
  ["reconnect", "/reconnect"],
  ["search", "/search"],
  ["people", "/people"],
  ["at-risk", "/at-risk"],
  ["logs", "/logs"],
  ["demo", "/demo"],
  ["not-found", "/mobile-audit-not-found"]
];

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark"
});
await context.grantPermissions(["microphone"], { origin: baseUrl });

const results = [];

async function inspectLayout(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - viewportWidth;
    const offenders = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const verticallyVisible = rect.bottom > 0 && rect.top < window.innerHeight;
        return verticallyVisible && rect.width > 1 && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 10)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          testId: element.getAttribute("data-testid"),
          text: element.textContent?.trim().slice(0, 80) ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width)
        };
      });
    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: Math.max(0, overflow),
      offenders
    };
  });
}

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.locator("body").waitFor({ state: "visible" });
  await page.waitForTimeout(900);
}

for (const [name, route] of routes) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/events")) {
      requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const layout = await inspectLayout(page);
  await page.screenshot({ path: resolve(outputDir, `${name}.png`), fullPage: false });
  results.push({
    name,
    route,
    status: response?.status() ?? null,
    finalUrl: page.url(),
    title: await page.title(),
    layout,
    consoleErrors,
    pageErrors,
    requestFailures,
    httpErrors
  });
  await page.close();
}

const threadPage = await context.newPage();
await threadPage.route("**/runner/control/transcribe-dictation", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, text: "Mobile dictation test" })
  });
});
await threadPage.goto(`${baseUrl}/thread/${threadId}`, { waitUntil: "domcontentloaded" });
await settle(threadPage);

await threadPage.getByTestId("composer-more-toggle").click();
const moreSheet = threadPage.getByRole("dialog", { name: "Add to your reply" });
await moreSheet.waitFor({ state: "visible" });
await threadPage.screenshot({ path: resolve(outputDir, "thread-more-sheet.png"), fullPage: false });
const moreLayout = await inspectLayout(threadPage);

const suggestions = moreSheet.getByRole("button", { name: /Suggested replies/ });
let suggestionsLayout = null;
if ((await suggestions.count()) > 0 && (await suggestions.isEnabled())) {
  await suggestions.click();
  const suggestionSheet = threadPage.getByRole("dialog", { name: "Suggested replies" });
  await suggestionSheet.waitFor({ state: "visible" });
  suggestionsLayout = await inspectLayout(threadPage);
  await threadPage.screenshot({
    path: resolve(outputDir, "thread-suggested-replies.png"),
    fullPage: false
  });
  await suggestionSheet.getByRole("button", { name: "Close" }).click();
}

await threadPage.getByTestId("composer-more-toggle").click();
const fileSheet = threadPage.getByRole("dialog", { name: "Add to your reply" });
await fileSheet.waitFor({ state: "visible" });
const fileAction = fileSheet.getByRole("button", { name: /Photo or file/ });
let fileAttachmentWorked = false;
if ((await fileAction.count()) > 0) {
  const fileChooserPromise = threadPage.waitForEvent("filechooser");
  await fileAction.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "mobile-audit.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64"
    )
  });
  await threadPage.getByRole("button", { name: "Remove attachment" }).waitFor({ state: "visible" });
  fileAttachmentWorked = true;
  await threadPage.getByRole("button", { name: "Remove attachment" }).click();
}

await threadPage.getByTestId("composer-more-toggle").click();
const voiceSheet = threadPage.getByRole("dialog", { name: "Add to your reply" });
await voiceSheet.waitFor({ state: "visible" });
const voiceAction = voiceSheet.getByRole("button", { name: /Voice note/ });
let voiceNoteWorked = false;
if ((await voiceAction.count()) > 0) {
  await voiceAction.click();
  await threadPage.getByText("Voice note recording", { exact: true }).waitFor({ state: "visible" });
  await threadPage.getByRole("button", { name: "Stop and attach" }).click();
  await threadPage.getByRole("button", { name: "Remove attachment" }).waitFor({ state: "visible" });
  voiceNoteWorked = true;
  await threadPage.getByRole("button", { name: "Remove attachment" }).click();
}

const dictateButton = threadPage.getByRole("button", { name: "Dictate", exact: true });
let dictationWorked = false;
if (await dictateButton.isEnabled()) {
  const captureContext = await threadPage.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    origin: window.location.origin
  }));
  if (!captureContext.isSecureContext) {
    throw new Error(`Dictate was enabled on an insecure origin: ${captureContext.origin}`);
  }
  await dictateButton.click();
  await dictateButton.getByText("Stop", { exact: true }).waitFor({ state: "visible" });
  await threadPage.waitForTimeout(700);
  await dictateButton.click();
  await threadPage.getByText("Mobile dictation test", { exact: true }).waitFor({ state: "visible" });
  dictationWorked = true;
  await threadPage.getByRole("button", { name: "Keep transcript and close" }).click();
}

await threadPage.getByTestId("thread-composer-input").focus();
await threadPage.evaluate(() => {
  document.documentElement.style.setProperty("--app-vv-height", "400px");
});
const keyboardViewport = await threadPage.evaluate(() => {
  const shell = document.querySelector('[data-scroll-owner="shell"]')?.getBoundingClientRect();
  const composer = document.querySelector('[data-testid="thread-composer-footer"]')?.getBoundingClientRect();
  return shell && composer
    ? {
        shellTop: Math.round(shell.top),
        shellHeight: Math.round(shell.height),
        composerTop: Math.round(composer.top),
        composerBottom: Math.round(composer.bottom),
        visibleBottom: 400,
        documentScrollTop: Math.round(document.documentElement.scrollTop),
        bodyScrollTop: Math.round(document.body.scrollTop),
        documentOverflow: Math.max(
          0,
          Math.round(document.documentElement.scrollHeight - document.documentElement.clientHeight)
        )
      }
    : null;
});
await threadPage.screenshot({ path: resolve(outputDir, "thread-keyboard-viewport.png"), fullPage: false });
results.push({
  name: "thread-interactions",
  moreLayout,
  suggestionsLayout,
  fileAttachmentWorked,
  voiceNoteWorked,
  dictationWorked,
  keyboardViewport
});
await threadPage.close();

const focusPage = await context.newPage();
await focusPage.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
await settle(focusPage);
await focusPage.evaluate(() => {
  window.dispatchEvent(new CustomEvent("focus:open-setup"));
});
const focusSheet = focusPage.getByRole("dialog");
await focusSheet.waitFor({ state: "visible" });
const autoSwitch = focusSheet.getByRole("switch", { name: /Send this note automatically/ });
const focusAutoBefore = await autoSwitch.getAttribute("aria-checked");
await autoSwitch.click();
await focusPage.waitForTimeout(250);
const focusAutoAfter = await autoSwitch.getAttribute("aria-checked");
const focusLayout = await inspectLayout(focusPage);
await focusPage.screenshot({ path: resolve(outputDir, "focus-auto-send.png"), fullPage: false });
results.push({ name: "focus-auto-send", focusAutoBefore, focusAutoAfter, layout: focusLayout });
await focusPage.close();

const desktopWidthPhoneContext = await browser.newContext({
  viewport: { width: 980, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark"
});
const desktopWidthPhonePage = await desktopWidthPhoneContext.newPage();
await desktopWidthPhonePage.goto(`${baseUrl}/thread/${threadId}`, { waitUntil: "domcontentloaded" });
await settle(desktopWidthPhonePage);
await desktopWidthPhonePage.getByTestId("composer-mobile-actions").waitFor({ state: "attached" });
await desktopWidthPhonePage.getByTestId("composer-desktop-actions").waitFor({ state: "attached" });
const coarsePhoneControls = await desktopWidthPhonePage.evaluate(() => {
  const mobile = document.querySelector('[data-testid="composer-mobile-actions"]');
  const desktop = document.querySelector('[data-testid="composer-desktop-actions"]');
  return {
    phoneQuery: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    mobileDisplay: mobile ? getComputedStyle(mobile).display : null,
    desktopDisplay: desktop ? getComputedStyle(desktop).display : null
  };
});
await desktopWidthPhonePage.getByTestId("composer-more-toggle").click();
const desktopWidthSheet = desktopWidthPhonePage.getByRole("dialog", { name: "Add to your reply" });
await desktopWidthSheet.waitFor({ state: "visible" });
const desktopWidthLayout = await inspectLayout(desktopWidthPhonePage);
await desktopWidthPhonePage.screenshot({
  path: resolve(outputDir, "thread-coarse-desktop-width.png"),
  fullPage: false
});
results.push({
  name: "thread-coarse-desktop-width",
  controls: coarsePhoneControls,
  layout: desktopWidthLayout
});
await desktopWidthPhonePage.close();
await desktopWidthPhoneContext.close();

if (insecurePhoneBaseUrl) {
  const insecureContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark"
  });
  const insecurePage = await insecureContext.newPage();
  if (insecurePhoneConnectUrl) {
    await insecurePage.goto(insecurePhoneConnectUrl, { waitUntil: "domcontentloaded" });
    await settle(insecurePage);
  }
  await insecurePage.goto(`${insecurePhoneBaseUrl}/thread/${threadId}`, {
    waitUntil: "domcontentloaded"
  });
  await settle(insecurePage);
  const composerInput = insecurePage.getByTestId("thread-composer-input");
  await composerInput.waitFor({ state: "visible" });
  const unavailable = insecurePage.getByRole("button", { name: "Dictation unavailable" });
  await unavailable.waitFor({ state: "visible" });
  const insecureDictationDisabled = await unavailable.isDisabled();
  const dictationRecovery = await insecurePage
    .getByTestId("dictation-secure-recovery")
    .textContent();
  await insecurePage.getByTestId("composer-more-toggle").click();
  const insecureSheet = insecurePage.getByRole("dialog", { name: "Add to your reply" });
  await insecureSheet.waitFor({ state: "visible" });
  const addRecording = insecureSheet.getByRole("button", { name: /Add voice recording/ });
  const fileChooserPromise = insecurePage.waitForEvent("filechooser");
  await addRecording.click();
  const recordingChooser = await fileChooserPromise;
  const recordingInput = insecurePage.locator("#voice-note-file-input");
  const recordingInputContract = await recordingInput.evaluate((element) => ({
    accept: element.getAttribute("accept"),
    capture: element.getAttribute("capture")
  }));
  await recordingChooser.setFiles({
    name: "mobile-audit.m4a",
    mimeType: "audio/mp4",
    buffer: Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0])
  });
  await insecurePage.getByRole("button", { name: "Remove attachment" }).waitFor({ state: "visible" });
  await insecurePage.screenshot({
    path: resolve(outputDir, "thread-insecure-iphone-audio.png"),
    fullPage: false
  });
  results.push({
    name: "thread-insecure-iphone-audio",
    secureContext: await insecurePage.evaluate(() => window.isSecureContext),
    dictationRecovery,
    insecureDictationDisabled,
    recordingInput: recordingInputContract
  });
  await insecurePage.close();
  await insecureContext.close();
}

await browser.close();
await writeFile(resolve(outputDir, "report.json"), JSON.stringify(results, null, 2));

const failures = results.flatMap((result) => {
  const found = [];
  const expectedAttachmentFailure = /\/runner\/data\/(?:imessage|whatsapp|google-messages)-attachment\//;
  const actionableHttpErrors = result.httpErrors?.filter(
    (failure) => !expectedAttachmentFailure.test(failure)
  ) ?? [];
  const actionableConsoleErrors = result.consoleErrors?.filter(
    (failure) =>
      !(
        actionableHttpErrors.length === 0 &&
        /^Failed to load resource: the server responded with a status of 5\d\d/.test(failure)
      )
  ) ?? [];
  const actionableRequestFailures = result.requestFailures?.filter(
    (failure) => !/\/thread\/[^?\s]+\?_rsc=\S+ net::ERR_ABORTED$/.test(failure)
  ) ?? [];
  if (result.status && result.status >= 400 && result.name !== "not-found") {
    found.push(`${result.name}: HTTP ${result.status}`);
  }
  if (result.layout?.horizontalOverflow > 1) {
    found.push(`${result.name}: horizontal overflow ${result.layout.horizontalOverflow}px`);
  }
  if (actionableConsoleErrors.length && result.name !== "not-found") {
    found.push(`${result.name}: console errors`);
  }
  if (result.pageErrors?.length) found.push(`${result.name}: page errors`);
  if (actionableRequestFailures.some((failure) => failure.includes(baseUrl))) {
    found.push(`${result.name}: local request failures`);
  }
  if (actionableHttpErrors.some((failure) => !failure.startsWith("404 ") || result.name !== "not-found")) {
    found.push(`${result.name}: HTTP resource errors`);
  }
  return found;
});
if (!results.find((result) => result.name === "thread-interactions")?.voiceNoteWorked) {
  failures.push("thread: voice-note interaction did not complete");
}
if (!results.find((result) => result.name === "thread-interactions")?.fileAttachmentWorked) {
  failures.push("thread: file attachment interaction did not complete");
}
if (!results.find((result) => result.name === "thread-interactions")?.dictationWorked) {
  failures.push("thread: dictation interaction did not complete");
}
if (results.find((result) => result.name === "focus-auto-send")?.focusAutoAfter !== "true") {
  failures.push("focus: automatic-send switch did not toggle");
}
const coarseDesktopWidth = results.find(
  (result) => result.name === "thread-coarse-desktop-width"
);
if (
  !coarseDesktopWidth?.controls?.phoneQuery ||
  coarseDesktopWidth.controls.mobileDisplay !== "flex" ||
  coarseDesktopWidth.controls.desktopDisplay !== "none" ||
  coarseDesktopWidth.layout?.horizontalOverflow > 1
) {
  failures.push("thread: touch-only desktop-width viewport did not keep phone controls");
}
const insecurePhoneAudio = results.find(
  (result) => result.name === "thread-insecure-iphone-audio"
);
if (
  insecurePhoneBaseUrl &&
  (!insecurePhoneAudio ||
    insecurePhoneAudio.secureContext !== false ||
    !insecurePhoneAudio.keyboardMicFocusedComposer ||
    insecurePhoneAudio.recordingInput?.capture !== null ||
    insecurePhoneAudio.recordingInput?.accept !== ".m4a,.mp3,.wav,.aac,.aif,.aiff,.caf")
) {
  failures.push("thread: insecure iPhone audio path could still invoke video capture");
}
const auditedKeyboardViewport = results.find(
  (result) => result.name === "thread-interactions"
)?.keyboardViewport;
if (
  !auditedKeyboardViewport ||
  auditedKeyboardViewport.shellTop !== 0 ||
  auditedKeyboardViewport.shellHeight !== auditedKeyboardViewport.visibleBottom ||
  auditedKeyboardViewport.composerBottom !== auditedKeyboardViewport.visibleBottom ||
  auditedKeyboardViewport.documentScrollTop !== 0 ||
  auditedKeyboardViewport.bodyScrollTop !== 0 ||
  auditedKeyboardViewport.documentOverflow !== 0
) {
  failures.push("thread: composer did not stay pinned to the keyboard viewport");
}

console.log(JSON.stringify({ outputDir, routeCount: routes.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
