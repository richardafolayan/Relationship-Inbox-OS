import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { chromium } from "patchright";
import { PrismaClient } from "@prisma/client";

const usage = `Usage: npm run perf:interactions -- [options]

Options:
  --runner URL       Runner origin (default http://127.0.0.1:4001)
  --dashboard URL    Dashboard origin (default http://127.0.0.1:3100)
  --thread ID        Thread fixture id
  --search TEXT      Search fixture text
  --samples COUNT    Samples per metric (default 30)
  --output PATH      Write the JSON result to a file
  --help             Show this help
`;

if (process.argv.includes("--help")) {
  process.stdout.write(usage);
  process.exit(0);
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const runnerUrl = args.get("--runner") ?? "http://127.0.0.1:4001";
const dashboardUrl = args.get("--dashboard") ?? "http://127.0.0.1:3100";
const threadId = args.get("--thread") ?? "perf-thread-00000";
const searchText = args.get("--search") ?? "Performance Contact 00999";
const samplesPerMetric = Number(args.get("--samples") ?? 30);
if (!Number.isInteger(samplesPerMetric) || samplesPerMetric < 1) {
  throw new Error("--samples must be a positive integer");
}
const outputPath = args.get("--output");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const raw = {};
const details = {};

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarise(values) {
  return {
    samples: values.length,
    p50_ms: Number(percentile(values, 0.5).toFixed(2)),
    p95_ms: Number(percentile(values, 0.95).toFixed(2)),
    min_ms: Number(Math.min(...values).toFixed(2)),
    max_ms: Number(Math.max(...values).toFixed(2))
  };
}

async function measure(label, iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation(index);
    values.push(performance.now() - startedAt);
  }
  raw[label] = values;
}

async function read(url, { bypassCache = false } = {}) {
  const response = await fetch(url, {
    headers: bypassCache ? { "Cache-Control": "no-cache" } : undefined
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await response.arrayBuffer();
}

await measure("api_health_ms", samplesPerMetric, () => read(`${runnerUrl}/health`));
await measure("api_inbox_cached_ms", samplesPerMetric, () => read(`${runnerUrl}/data/inbox`));
await measure("api_inbox_uncached_ms", samplesPerMetric, () =>
  read(`${runnerUrl}/data/inbox`, { bypassCache: true })
);
await measure("api_search_uncached_ms", samplesPerMetric, () =>
  read(`${runnerUrl}/data/inbox?search=${encodeURIComponent(searchText)}`, { bypassCache: true })
);
await measure("api_thread_ms", samplesPerMetric, () =>
  read(`${runnerUrl}/data/thread/${threadId}`)
);

if (process.env.DATABASE_URL) {
  const prisma = new PrismaClient();
  await measure("db_inbox_query_ms", samplesPerMetric, () =>
    prisma.thread.findMany({
      where: { archivedAt: null },
      select: { id: true, personId: true, lastMessageAt: true, riskLevel: true, needsReply: true },
      orderBy: { lastMessageAt: "desc" }
    })
  );
  await measure("db_thread_messages_query_ms", samplesPerMetric, () =>
    prisma.message.findMany({
      where: { threadId },
      select: { id: true, timestamp: true, direction: true, text: true },
      orderBy: { timestamp: "desc" },
      take: 60
    })
  );
  await measure("db_sent_today_count_ms", samplesPerMetric, () =>
    prisma.message.count({
      where: { direction: "OUT", timestamp: { gte: new Date(Date.now() - 86_400_000) } }
    })
  );
  await prisma.$disconnect();
}

const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromePath) ? { executablePath: chromePath } : {})
});
const context = await browser.newContext();
const page = await context.newPage();

await measure("browser_inbox_initial_render_ms", 10, async () => {
  await page.goto(`${dashboardUrl}/inbox`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Search people, keywords…").waitFor();
  await page.locator('a[href^="/thread/"]').first().waitFor();
});
details.inbox_initial_dom_rows = await page.locator('a[href^="/thread/"]').count();

if (await page.getByRole("button", { name: /Show \d+ more/ }).count()) {
  const pagination = [];
  for (let index = 0; index < Math.min(20, samplesPerMetric); index += 1) {
    await page.goto(`${dashboardUrl}/inbox`);
    const showMore = page.getByRole("button", { name: /Show \d+ more/ });
    await showMore.waitFor();
    const startedAt = performance.now();
    await showMore.click();
    await page.locator('a[href^="/thread/"]').nth(80).waitFor();
    pagination.push(performance.now() - startedAt);
  }
  raw.browser_pagination_more_ms = pagination;
}

const navigation = [];
for (let index = 0; index < Math.min(20, samplesPerMetric); index += 1) {
  const startedAt = performance.now();
  await page.locator('a[href^="/thread/"]').first().click();
  await page.locator('[data-thread-composer="true"]').waitFor();
  navigation.push(performance.now() - startedAt);
  await page.goto(`${dashboardUrl}/inbox`);
  await page.getByPlaceholder("Search people, keywords…").waitFor();
}
raw.browser_inbox_to_thread_ms = navigation;

const search = page.getByPlaceholder("Search people, keywords…");
const searchApply = [];
const searchClear = [];
for (let index = 0; index < samplesPerMetric; index += 1) {
  const value = searchText;
  let startedAt = performance.now();
  await search.fill(value);
  await page.getByText(value, { exact: true }).waitFor();
  searchApply.push(performance.now() - startedAt);

  startedAt = performance.now();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.locator('a[href^="/thread/"]').first().waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  searchClear.push(performance.now() - startedAt);
}
raw.browser_search_apply_ms = searchApply;
raw.browser_search_clear_ms = searchClear;

const filterApply = [];
const filterClear = [];
for (let index = 0; index < samplesPerMetric; index += 1) {
  await page.getByRole("button", { name: /Filters/ }).click();
  let startedAt = performance.now();
  await page.getByRole("button", { name: "LinkedIn" }).click();
  await page.getByRole("button", { name: "Remove Platform filter" }).waitFor();
  filterApply.push(performance.now() - startedAt);
  await page.getByRole("button", { name: /Filters/ }).click();

  await page.getByRole("button", { name: /Filters/ }).click();
  startedAt = performance.now();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Remove Platform filter" }).waitFor({ state: "hidden" });
  filterClear.push(performance.now() - startedAt);
  await page.getByRole("button", { name: /Filters/ }).click();
}
raw.browser_filter_apply_ms = filterApply;
raw.browser_filter_clear_ms = filterClear;

const acknowledgement = [];
for (let index = 0; index < samplesPerMetric; index += 1) {
  const startedAt = performance.now();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByTestId("inbox-select-count").waitFor();
  acknowledgement.push(performance.now() - startedAt);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByTestId("inbox-select-count").waitFor({ state: "hidden" });
}
raw.browser_click_acknowledgement_ms = acknowledgement;

await page.locator('a[href^="/thread/"]').first().click();
const composer = page.locator('textarea[placeholder^="Reply to "]').first();
await composer.waitFor();
await measure("browser_composer_input_ms", samplesPerMetric, async (index) => {
  const value = `My own reply ${index}`;
  await composer.fill(value);
  await page.waitForFunction((expected) => {
    const input = document.querySelector('textarea[placeholder^="Reply to "]');
    return input instanceof HTMLTextAreaElement && input.value === expected;
  }, value);
});

await context.close();
await browser.close();

const summary = Object.fromEntries(Object.entries(raw).map(([label, values]) => [label, summarise(values)]));
const output = { generated_at: new Date().toISOString(), details, summary, raw };
const rendered = JSON.stringify(output, null, 2) + "\n";
if (outputPath) await writeFile(outputPath, rendered);
process.stdout.write(rendered);
