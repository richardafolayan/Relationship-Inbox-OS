import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const readBinary = (path) => readFileSync(join(ROOT, path));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const { default: createManifest } = await import("../apps/dashboard/app/manifest.ts");
const { APP_NAME } = await import("../apps/dashboard/lib/branding.ts");
const {
  appleStatusBarStyleForTheme,
  themeColorForTheme
} = await import("../apps/dashboard/lib/apple-status-bar.ts");
const {
  capturePwaStandaloneSnapshot,
  formatPwaStandaloneLog,
  parsePwaDebugQuery,
  readPwaDebugEnabled,
  syncPwaDebugFromLocation
} = await import("../apps/dashboard/lib/pwa-standalone-debug.ts");

test("web app manifest launches as a scoped standalone app from /today", () => {
  const manifest = createManifest();
  assert.equal(manifest.name, APP_NAME);
  assert.equal(manifest.short_name, APP_NAME);
  assert.equal(manifest.start_url, "/today");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "/");
  // No portrait lock: landscape phones/tablets stay usable for the pilot.
  assert.equal(manifest.orientation, undefined);
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

  const any512 = manifest.icons.find(
    (icon) => icon.sizes === "512x512" && icon.purpose !== "maskable"
  );
  const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
  assert.ok(any512, "expected a non-maskable 512 icon");
  assert.ok(maskable, "expected a maskable icon");
  const anyHash = sha256(readBinary(join("apps/dashboard/public", any512.src)));
  const maskHash = sha256(readBinary(join("apps/dashboard/public", maskable.src)));
  assert.notEqual(
    anyHash,
    maskHash,
    "maskable 512 must differ from the full-bleed 512 (needs safe-zone padding)"
  );
});

test("root layout declares Apple standalone metadata and manifest link", () => {
  const layout = read("apps/dashboard/app/layout.tsx");
  assert.match(layout, /manifest:\s*["']\/manifest\.webmanifest["']/);
  assert.match(layout, /appleWebApp:\s*\{/);
  assert.match(layout, /capable:\s*true/);
  // Opaque status bar until the shell owns env(safe-area-inset-top).
  assert.match(layout, /statusBarStyle:\s*["']default["']/);
  assert.doesNotMatch(layout, /statusBarStyle:\s*["']black-translucent["']/);
  // Theme bootstrap may set opaque "black" for dark mode, never translucent.
  assert.match(layout, /var bar=t==='dark'\?'black':'default'/);
  assert.doesNotMatch(layout, /['"]black-translucent['"]/);
  assert.match(layout, /PwaStandaloneDebug/);
  assert.match(layout, /formatDetection:\s*\{/);
  assert.match(layout, /telephone:\s*false/);
  assert.match(layout, /applicationName:\s*APP_NAME/);
  assert.match(layout, /title:\s*APP_NAME/);
  assert.match(layout, /\/icons\/tovi-180\.png/);
});

test("opaque Apple status bar follows app theme without translucent notch draw", () => {
  assert.equal(appleStatusBarStyleForTheme("light"), "default");
  assert.equal(appleStatusBarStyleForTheme("dark"), "black");
  assert.equal(themeColorForTheme("light"), "#f7f2e8");
  assert.equal(themeColorForTheme("dark"), "#000000");

  const toggle = read("apps/dashboard/components/layout/theme-toggle.tsx");
  assert.match(toggle, /applyAppleChromeForTheme/);
});

test("pwa debug helper opts in via query and logs standalone snapshot fields", () => {
  assert.equal(parsePwaDebugQuery("?pwaDebug=1"), "on");
  assert.equal(parsePwaDebugQuery("pwaDebug=0"), "off");
  assert.equal(parsePwaDebugQuery(""), null);

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    }
  };

  assert.equal(syncPwaDebugFromLocation("?pwaDebug=1", storage), true);
  assert.equal(readPwaDebugEnabled("", storage), true);
  assert.equal(syncPwaDebugFromLocation("?pwaDebug=0", storage), false);
  assert.equal(readPwaDebugEnabled("", storage), false);

  const snapshot = capturePwaStandaloneSnapshot({
    href: "https://pilot.example/today",
    origin: "https://pilot.example",
    pathname: "/today",
    matchMediaStandalone: true,
    iosStandalone: true
  });
  assert.equal(snapshot.standalone, true);
  assert.equal(snapshot.iosStandalone, true);
  const line = formatPwaStandaloneLog(snapshot);
  assert.match(line, /\[pwa-debug\]/);
  assert.match(line, /href=https:\/\/pilot\.example\/today/);
  assert.match(line, /origin=https:\/\/pilot\.example/);
  assert.match(line, /standalone=true/);
  assert.match(line, /iosStandalone=true/);

  const component = read("apps/dashboard/components/common/pwa-standalone-debug.tsx");
  assert.match(component, /syncPwaDebugFromLocation/);
  assert.match(component, /logPwaStandaloneSnapshot/);
  assert.match(component, /usePathname/);
});

// Primary same-origin nav must stay inside the installed PWA (Link / router.push,
// never target=_blank or window.open). Intentional leave-PWA exits remain elsewhere
// and are out of scope for this regression: receipts/media open attachments with
// target=_blank, message body links and the in-app browser fallback use window.open
// / _blank, setup wizard links to Google AI Studio externally, people page profile
// links, etc. Those are deliberate exits from standalone scope.
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
