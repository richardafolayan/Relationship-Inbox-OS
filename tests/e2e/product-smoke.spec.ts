import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("relationship-inbox-os:setup-wizard-complete:v1", "1");
    localStorage.setItem("relationship-inbox-os:pilot-guided-demo-seen:v1", "1");
    localStorage.setItem("pilot_welcome_dismissed", "1");
  });
});

test("primary pages have truthful route contracts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium-1440x900");

  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("today-page")).toBeVisible();

  const pages = [
    ["/inbox", "Inbox"],
    ["/reconnect", "Reconnect"],
    ["/archived", "Archived"],
    ["/settings", "Settings"]
  ] as const;

  for (const [path, heading] of pages) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    if (path === "/inbox") {
      await expect(page.locator('a[href^="/thread/perf-thread-"]').first()).toBeVisible();
    }
  }
});

test("support pages have truthful route contracts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium-1440x900");

  const pages = [
    ["/platforms", "Platforms"],
    ["/people", "People"],
    ["/logs", "Activity"],
    ["/demo", "Run demo"]
  ] as const;

  for (const [path, heading] of pages) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
  }

  await page.goto("/search");
  await expect(page.getByPlaceholder("Search conversations")).toBeVisible();
});

test("dynamic, legacy, and missing routes stay truthful", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium-1440x900");

  await page.goto("/inbox");
  const threadHref = await page.locator('a[href^="/thread/"]').first().getAttribute("href");
  expect(threadHref).toBeTruthy();
  await page.goto(threadHref!);
  await expect(page.locator('[data-thread-composer="true"]')).toBeVisible();

  await page.goto("/at-risk");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("today-page")).toBeVisible();

  const missing = await page.goto("/this-route-does-not-exist");
  expect(missing?.status()).toBe(404);
  await expect(page.getByText("This page is no longer here.", { exact: true })).toBeVisible();
});

test("desktop Search is keyboard-operable and restores its opener", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-"));
  await page.goto("/inbox");

  const opener = page.getByRole("button", { name: "Search (⌘K)" });
  await opener.focus();
  await opener.click();

  const combobox = page.getByRole("combobox", {
    name: "Search conversations, pages, or actions"
  });
  await expect(combobox).toBeFocused();
  await expect(combobox).toHaveAttribute("aria-controls");
  await expect(page.getByRole("listbox", { name: "Search results" })).toBeVisible();
  await combobox.fill("Reconnect");
  await expect(page.getByRole("option", { name: /Go to Reconnect/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("unsent text remains scoped to its thread through app navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium-1440x900");
  await page.goto("/inbox");
  const threadLink = page.locator('a[href^="/thread/"]').first();
  const href = await threadLink.getAttribute("href");
  expect(href).toBeTruthy();
  await threadLink.click();

  const composer = page.getByTestId("thread-composer-input");
  const draft = "A private unsent smoke-test note";
  await composer.fill(draft);
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await page.goto(href!);
  await expect(page.getByTestId("thread-composer-input")).toHaveValue(draft);
});

test("People load failure is recoverable, not an empty-account claim", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium-1440x900");
  await page.route("**/runner/data/people", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' })
  );
  await page.goto("/people");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("No relationships yet.", { exact: true })).toHaveCount(0);
});

test("phone navigation stays in-app and thread Back returns to its origin", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone-"));
  await page.goto("/inbox");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await page.locator('a[href^="/thread/"]').first().click();
  await expect(page.locator('[data-thread-composer="true"]')).toBeVisible();

  const composerBox = await page.locator('[data-thread-composer="true"]').boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1
  );

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/inbox(?:\?.*)?$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole("link", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/search/);
  await expect(page.getByPlaceholder("Search conversations")).toBeVisible();
});
