import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "patchright";

const baseUrl = process.env.MOBILE_AUDIT_BASE_URL ?? "http://127.0.0.1:3110";
const insecurePhoneBaseUrl = process.env.MOBILE_AUDIT_INSECURE_BASE_URL;
const insecurePhoneConnectUrl = process.env.MOBILE_AUDIT_INSECURE_CONNECT_URL;
const threadId = process.env.MOBILE_AUDIT_THREAD_ID;
const viewportOnly = process.env.MOBILE_AUDIT_VIEWPORT_ONLY === "1";
if (!threadId) throw new Error("MOBILE_AUDIT_THREAD_ID is required");

const outputDir = resolve(process.cwd(), ".mobile-audit");
await mkdir(outputDir, { recursive: true });

const routes = viewportOnly ? [] : [
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

async function resizeViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
}

async function inspectKeyboardViewport(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const bounds = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect
        ? {
            top: round(rect.top),
            right: round(rect.right),
            bottom: round(rect.bottom),
            left: round(rect.left),
            width: round(rect.width),
            height: round(rect.height)
          }
        : null;
    };
    const timeline = document.querySelector('[data-testid="thread-message-timeline"]');
    const viewport = window.visualViewport;
    return {
      shell: bounds('[data-scroll-owner="shell"]'),
      main: bounds('main[data-scroll-owner="child"]'),
      threadRoot: bounds('[data-testid="thread-root"]'),
      chatColumn: bounds('[data-testid="thread-chat-column"]'),
      timelineBounds: bounds('[data-testid="thread-message-timeline"]'),
      composer: bounds('[data-testid="thread-composer-footer"]'),
      actionSheet: bounds('[data-testid="thread-action-sheet-root"]'),
      visibleTop: round(viewport?.offsetTop ?? 0),
      visibleBottom: round((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)),
      viewportScale: viewport?.scale ?? 1,
      bodyZoom: getComputedStyle(document.body).zoom,
      documentScrollTop: round(document.documentElement.scrollTop),
      bodyScrollTop: round(document.body.scrollTop),
      documentVerticalOverflow: Math.max(
        0,
        round(document.documentElement.scrollHeight - document.documentElement.clientHeight)
      ),
      bodyVerticalOverflow: Math.max(
        0,
        round(document.body.scrollHeight - document.documentElement.clientHeight)
      ),
      horizontalOverflow: Math.max(
        0,
        round(document.documentElement.scrollWidth - document.documentElement.clientWidth)
      ),
      timeline: timeline
        ? {
            scrollTop: round(timeline.scrollTop),
            distanceFromBottom: round(
              timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop
            )
          }
        : null
    };
  });
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

if (!viewportOnly) {
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
await threadPage.getByTestId("thread-composer-input").waitFor({
  state: "visible",
  timeout: 60_000
});

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
  await dictateButton.click();
  await dictateButton.getByText("Stop", { exact: true }).waitFor({ state: "visible" });
  await threadPage.waitForTimeout(700);
  await dictateButton.click();
  await threadPage.getByText("Mobile dictation test", { exact: true }).waitFor({ state: "visible" });
  dictationWorked = true;
  await threadPage.getByRole("button", { name: "Keep transcript and close" }).click();
}

results.push({
  name: "thread-interactions",
  moreLayout,
  suggestionsLayout,
  fileAttachmentWorked,
  voiceNoteWorked,
  dictationWorked
});
await threadPage.close();
}

const viewportContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark"
});
const viewportPage = await viewportContext.newPage();
await viewportPage.goto(`${baseUrl}/thread/${threadId}`, { waitUntil: "domcontentloaded" });
await settle(viewportPage);
const viewportComposer = viewportPage.getByTestId("thread-composer-input");
await viewportComposer.waitFor({ state: "visible", timeout: 60_000 });
await viewportPage.evaluate(() => {
  const timeline = document.querySelector('[data-testid="thread-message-timeline"]');
  timeline.scrollTop = timeline.scrollHeight;
  timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
});
await viewportPage.waitForTimeout(80);
await viewportComposer.focus();
await viewportPage.evaluate(() => {
  const timeline = document.querySelector('[data-testid="thread-message-timeline"]');
  timeline.scrollTop = timeline.scrollHeight;
  timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
});
await viewportPage.waitForTimeout(80);

await resizeViewport(viewportPage, 390, 400);
const keyboardOffsetZero = await inspectKeyboardViewport(viewportPage);
await viewportPage.screenshot({
  path: resolve(outputDir, "thread-keyboard-portrait.png"),
  fullPage: false,
  mask: [
    viewportPage.getByTestId("thread-header-band"),
    viewportPage.getByTestId("thread-brief-row"),
    viewportPage.getByTestId("thread-message-timeline"),
    viewportPage.getByTestId("thread-composer-input")
  ]
});

const viewportCdp = await viewportContext.newCDPSession(viewportPage);
await viewportCdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.2 });
await viewportPage.waitForTimeout(80);
const keyboardScaled = await inspectKeyboardViewport(viewportPage);
await viewportCdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
await resizeViewport(viewportPage, 390, 400);

const zoomModes = {};
for (const mode of ["normal", "large", "extra"]) {
  await viewportPage.evaluate((nextMode) => {
    if (nextMode === "normal") delete document.documentElement.dataset.uiScale;
    else document.documentElement.dataset.uiScale = nextMode;
    window.dispatchEvent(new CustomEvent("inbox-ui-scale"));
  }, mode);
  await resizeViewport(viewportPage, 390, 400);
  zoomModes[mode] = await inspectKeyboardViewport(viewportPage);
}

await viewportPage.getByTestId("composer-more-toggle").click();
const keyboardSheet = viewportPage.getByRole("dialog", { name: "Add to your reply" });
await keyboardSheet.waitFor({ state: "visible" });
const keyboardActionSheet = await inspectKeyboardViewport(viewportPage);
await keyboardSheet.getByRole("button", { name: "Close" }).click();

await viewportComposer.blur();
await resizeViewport(viewportPage, 390, 844);
const keyboardDismissed = await inspectKeyboardViewport(viewportPage);

await viewportPage.evaluate(() => {
  const timeline = document.querySelector('[data-testid="thread-message-timeline"]');
  timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight - 600);
  timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
});
const olderBefore = await inspectKeyboardViewport(viewportPage);
await viewportComposer.focus();
await resizeViewport(viewportPage, 390, 400);
const olderDuring = await inspectKeyboardViewport(viewportPage);

await resizeViewport(viewportPage, 844, 390);
await viewportPage.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
await viewportPage.waitForTimeout(80);
const keyboardOrientation = await inspectKeyboardViewport(viewportPage);

results.push({
  name: "thread-keyboard-viewport",
  offsetZero: keyboardOffsetZero,
  scaled: keyboardScaled,
  zoomModes,
  actionSheet: keyboardActionSheet,
  dismissed: keyboardDismissed,
  olderBefore,
  olderDuring,
  orientation: keyboardOrientation
});
await viewportPage.close();
await viewportContext.close();

if (!viewportOnly) {
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
await context.close();

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
  const keyboardMic = insecurePage.getByRole("button", { name: "Use keyboard microphone" });
  await keyboardMic.click();
  const keyboardMicFocusedComposer = await composerInput.evaluate(
    (element) => document.activeElement === element
  );
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
    keyboardMicFocusedComposer,
    recordingInput: recordingInputContract
  });
  await insecurePage.close();
  await insecureContext.close();
}
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
if (!viewportOnly && !results.find((result) => result.name === "thread-interactions")?.voiceNoteWorked) {
  failures.push("thread: voice-note interaction did not complete");
}
if (!viewportOnly && !results.find((result) => result.name === "thread-interactions")?.fileAttachmentWorked) {
  failures.push("thread: file attachment interaction did not complete");
}
if (!viewportOnly && !results.find((result) => result.name === "thread-interactions")?.dictationWorked) {
  failures.push("thread: dictation interaction did not complete");
}
if (!viewportOnly && results.find((result) => result.name === "focus-auto-send")?.focusAutoAfter !== "true") {
  failures.push("focus: automatic-send switch did not toggle");
}
const coarseDesktopWidth = results.find(
  (result) => result.name === "thread-coarse-desktop-width"
);
if (
  !viewportOnly &&
  (
    !coarseDesktopWidth?.controls?.phoneQuery ||
    coarseDesktopWidth.controls.mobileDisplay !== "flex" ||
    coarseDesktopWidth.controls.desktopDisplay !== "none" ||
    coarseDesktopWidth.layout?.horizontalOverflow > 1
  )
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
  (result) => result.name === "thread-keyboard-viewport"
);
const closeTo = (left, right, tolerance = 1) =>
  typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= tolerance;
const viewportAligned = (geometry) =>
  geometry
  && closeTo(geometry.shell?.top, geometry.visibleTop)
  && closeTo(geometry.shell?.bottom, geometry.visibleBottom)
  && closeTo(geometry.composer?.bottom, geometry.visibleBottom)
  && geometry.documentScrollTop === 0
  && geometry.bodyScrollTop === 0
  && geometry.documentVerticalOverflow === 0
  && geometry.bodyVerticalOverflow === 0
  && geometry.horizontalOverflow === 0;

if (
  !viewportAligned(auditedKeyboardViewport?.offsetZero)
  || auditedKeyboardViewport.offsetZero.timeline?.distanceFromBottom > 1
) {
  failures.push("thread: zero-offset keyboard viewport was not aligned or bottom-anchored");
}
if (
  !viewportAligned(auditedKeyboardViewport?.scaled)
  || auditedKeyboardViewport.scaled.viewportScale <= 1
) {
  failures.push("thread: scaled visual viewport was not aligned");
}
for (const [mode, expectedZoom] of [["normal", 1], ["large", 1.08], ["extra", 1.16]]) {
  const geometry = auditedKeyboardViewport?.zoomModes?.[mode];
  if (!viewportAligned(geometry) || !closeTo(Number(geometry?.bodyZoom), expectedZoom, 0.001)) {
    failures.push(`thread: ${mode} text-size zoom broke keyboard viewport alignment`);
  }
}
if (
  !viewportAligned(auditedKeyboardViewport?.actionSheet)
  || !closeTo(
    auditedKeyboardViewport.actionSheet.actionSheet?.top,
    auditedKeyboardViewport.actionSheet.visibleTop
  )
  || !closeTo(
    auditedKeyboardViewport.actionSheet.actionSheet?.bottom,
    auditedKeyboardViewport.actionSheet.visibleBottom
  )
) {
  failures.push("thread: action sheet did not cover the visible keyboard viewport");
}
if (!viewportAligned(auditedKeyboardViewport?.dismissed)) {
  failures.push("thread: full viewport did not restore after keyboard dismissal");
}
if (
  !viewportAligned(auditedKeyboardViewport?.olderDuring)
  || auditedKeyboardViewport.olderBefore.timeline?.distanceFromBottom < 500
  || !closeTo(
    auditedKeyboardViewport.olderBefore.timeline?.scrollTop,
    auditedKeyboardViewport.olderDuring.timeline?.scrollTop
  )
) {
  failures.push("thread: keyboard resize did not preserve an older timeline position");
}
if (!viewportAligned(auditedKeyboardViewport?.orientation)) {
  failures.push("thread: orientation change did not restore visible viewport alignment");
}

console.log(JSON.stringify({ outputDir, routeCount: viewportOnly ? 0 : routes.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
