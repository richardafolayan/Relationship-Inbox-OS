import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const externalBaseUrl = process.env.TOVI_SMOKE_BASE_URL;
const dashboardPort = process.env.TOVI_SMOKE_DASHBOARD_PORT ?? "3311";
const runnerPort = process.env.TOVI_SMOKE_RUNNER_PORT ?? "4311";
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${dashboardPort}`;
const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromiumLaunchOptions =
  process.platform === "darwin" && existsSync(localChrome)
    ? { executablePath: localChrome }
    : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: "test-results/smoke",
  reporter: [["list"], ["junit", { outputFile: "test-results/smoke/junit.xml" }]],
  use: {
    baseURL,
    locale: "en-GB",
    timezoneId: "Europe/London",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: `${process.execPath} scripts/testing/start-smoke-runner.mjs`,
          url: `http://127.0.0.1:${runnerPort}/health`,
          timeout: 120_000,
          reuseExistingServer: false,
          env: { RUNNER_PORT: runnerPort }
        },
        {
          command: "npm run start --workspace @inbox-os/dashboard",
          url: baseURL,
          timeout: 120_000,
          reuseExistingServer: false,
          env: {
            DASHBOARD_PORT: dashboardPort,
            RUNNER_PORT: runnerPort,
            NEXT_PUBLIC_DISABLE_AUTOSCAN: "1",
            NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN: "1"
          }
        }
      ],
  projects: [
    {
      name: "desktop-chromium-1440x900",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: chromiumLaunchOptions
      }
    },
    {
      name: "desktop-small-1024x700",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 700 },
        launchOptions: chromiumLaunchOptions
      }
    },
    {
      name: "phone-webkit-390x844",
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } }
    },
    {
      name: "phone-webkit-small-360x640",
      use: { ...devices["iPhone SE"], viewport: { width: 360, height: 640 } }
    },
    {
      name: "phone-chromium-360x800",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 360, height: 800 },
        browserName: "chromium",
        launchOptions: chromiumLaunchOptions
      }
    }
  ]
});
