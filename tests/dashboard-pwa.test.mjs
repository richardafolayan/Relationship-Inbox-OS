import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const { default: createManifest } = await import("../apps/dashboard/app/manifest.ts");
const { APP_NAME } = await import("../apps/dashboard/lib/branding.ts");

test("web app manifest launches as a scoped standalone app from /today", () => {
  const manifest = createManifest();
  assert.equal(manifest.name, APP_NAME);
  assert.equal(manifest.short_name, APP_NAME);
  assert.equal(manifest.start_url, "/today");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "/");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith("/icons/"), `icon src must be same-origin: ${icon.src}`);
    assert.ok(
      existsSync(join(ROOT, "apps/dashboard/public", icon.src)),
      `missing icon file: ${icon.src}`
    );
  }
});

test("root layout declares Apple standalone metadata and manifest link", () => {
  const layout = read("apps/dashboard/app/layout.tsx");
  assert.match(layout, /manifest:\s*["']\/manifest\.webmanifest["']/);
  assert.match(layout, /appleWebApp:\s*\{/);
  assert.match(layout, /capable:\s*true/);
  assert.match(layout, /statusBarStyle:\s*["']black-translucent["']/);
  assert.match(layout, /formatDetection:\s*\{/);
  assert.match(layout, /telephone:\s*false/);
  assert.match(layout, /applicationName:\s*APP_NAME/);
  assert.match(layout, /title:\s*APP_NAME/);
  assert.match(layout, /\/icons\/tovi-180\.png/);
});

test("primary nav stays same-origin so standalone PWA scope is preserved", () => {
  const dock = read("apps/dashboard/components/layout/mobile-dock.tsx");
  const sidebar = read("apps/dashboard/components/layout/sidebar.tsx");
  const row = read("apps/dashboard/components/common/thread-row.tsx");
  const palette = read("apps/dashboard/components/layout/command-palette.tsx");

  assert.match(dock, /href:\s*["']\/today["']/);
  assert.match(dock, /href:\s*["']\/inbox["']/);
  assert.match(dock, /from "next\/link"/);
  assert.doesNotMatch(dock, /target=["']_blank["']/);
  assert.doesNotMatch(dock, /window\.open/);

  assert.match(sidebar, /href:\s*["']\/today["']/);
  assert.match(sidebar, /href:\s*["']\/inbox["']/);
  assert.doesNotMatch(sidebar, /target=["']_blank["']/);
  assert.doesNotMatch(sidebar, /window\.open/);

  assert.match(row, /href=\{`\/thread\/\$\{row\.id\}`\}/);
  assert.doesNotMatch(row, /target=["']_blank["']/);

  assert.match(palette, /router\.push\(["']\/today["']\)/);
  assert.match(palette, /router\.push\(["']\/inbox["']\)/);
  assert.match(palette, /router\.push\(`\/thread\/\$\{thread\.id\}`\)/);
  assert.doesNotMatch(palette, /window\.open/);
});
