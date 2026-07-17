import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "apps/dashboard/app/settings/page.tsx"), "utf8");

function tabFromHash(hash) {
  const tabs = ["setup", "platforms", "capture", "notifications", "writing", "focus", "app", "pilot"];
  const clean = hash.replace(/^#/, "");
  if (tabs.includes(clean)) return clean;
  if (clean === "app-updates") return "app";
  if (clean === "reply-style") return "writing";
  return null;
}

test("deep links map category hashes and aliases to the correct tab", () => {
  assert.equal(tabFromHash("#platforms"), "platforms");
  assert.equal(tabFromHash("focus"), "focus");
  assert.equal(tabFromHash("#app-updates"), "app");
  assert.equal(tabFromHash("#reply-style"), "writing");
  assert.equal(tabFromHash("#writing"), "writing");
  assert.equal(tabFromHash(""), null);
  assert.equal(tabFromHash("#unknown"), null);
  assert.match(SOURCE, /function tabFromHash\(hash: string\): SettingsTabId \| null/);
  assert.match(SOURCE, /if \(clean === "app-updates"\) return "app"/);
  assert.match(SOURCE, /if \(clean === "reply-style"\) return "writing"/);
});

test("phone Settings opens as a category landing list without in-page section grid", () => {
  assert.match(SOURCE, /const \[mobileDetailOpen, setMobileDetailOpen\] = useState\(false\)/);
  assert.match(
    SOURCE,
    /<nav aria-label="Settings sections" className="md:hidden">/
  );
  assert.match(SOURCE, /onMobileChoose=\{openMobileCategory\}/);
  // Capture list offset from the shell scroller (<main>), not window.
  assert.match(
    SOURCE,
    /listScrollYRef\.current = document\.querySelector\(["']main["']\)\?\.scrollTop/
  );
  // Landing is a simple vertical list (not the old 2-col card grid on phone).
  assert.doesNotMatch(
    SOURCE,
    /grid grid-cols-2 gap-2 sm:grid-cols-3 md:sticky/
  );
});

test("each category opens as a mobile subpage with Back to Settings header", () => {
  assert.match(SOURCE, /const openMobileCategory = \(tab: SettingsTabId\) =>/);
  assert.match(SOURCE, /window\.history\.pushState\(\{ settingsMobileDetail: true, tab \}/);
  assert.match(SOURCE, /aria-label="Back to Settings"/);
  assert.match(SOURCE, /const backToSettingsList = \(\) =>/);
  assert.match(SOURCE, /ChevronLeft/);
  assert.match(SOURCE, /aria-hidden \/>\s*\n\s*Settings\s*\n\s*<\/button>/);
  assert.match(
    SOURCE,
    /sticky top-0 z-10[^"]*md:hidden/
  );
});

test("Back returns to the Settings list and preserves list scroll position", () => {
  assert.match(SOURCE, /state\?\.settingsMobileDetail/);
  assert.match(SOURCE, /window\.history\.back\(\)/);
  assert.match(SOURCE, /clearSettingsHashUrl/);
  assert.match(SOURCE, /setMobileDetailOpen\(false\)/);
  assert.match(SOURCE, /listScrollYRef/);
  // Restore and detail open-to-top must target <main> (AppShell scroller).
  // Document scroll APIs are false-green under the overflow-hidden shell.
  assert.match(SOURCE, /document\.querySelector\(["']main["']\)/);
  assert.match(SOURCE, /\.scrollTop\s*=\s*y/);
  assert.match(SOURCE, /\.scrollTop\s*=\s*0/);
  assert.doesNotMatch(SOURCE, /window\.scrollTo\s*\(/);
  assert.doesNotMatch(SOURCE, /window\.scrollY\b/);
  assert.match(SOURCE, /window\.addEventListener\("popstate", onLocation\)/);
});

test("deep-linked Back clears hash via replaceState so system Back does not reopen category", () => {
  // When history.state lacks settingsMobileDetail (direct /settings#platforms),
  // UI Back must replace the current entry, not push a list entry. pushState
  // leaves […, #category, list] so the next system Back reopens the category.
  assert.match(
    SOURCE,
    /window\.history\.replaceState\(\{ settingsList: true \}, "", clearSettingsHashUrl\(\)\)/
  );
  assert.doesNotMatch(
    SOURCE,
    /window\.history\.pushState\(\{ settingsList: true \}/
  );
  // List→detail still uses pushState with the marker for history.back().
  assert.match(
    SOURCE,
    /window\.history\.pushState\(\{ settingsMobileDetail: true, tab \}/
  );
});

test("only active category content is shown in the mobile detail viewport", () => {
  assert.match(
    SOURCE,
    /className=\{cn\("min-w-0", !mobileDetailOpen && "hidden md:block"\)\}/
  );
  assert.match(
    SOURCE,
    /className=\{cn\(mobileDetailOpen && "hidden md:block"\)\}/
  );
  assert.match(SOURCE, /\{activeTab === "setup" \? <SetupGuideSection/);
  assert.match(SOURCE, /\{activeTab === "platforms" \? \(/);
  assert.match(SOURCE, /\{activeTab === "pilot" \? \(/);
});

test("desktop keeps multi-column in-page settings navigation", () => {
  assert.match(
    SOURCE,
    /md:grid-cols-\[230px_minmax\(0,1fr\)\] xl:grid-cols-\[260px_minmax\(0,1fr\)\]/
  );
  assert.match(
    SOURCE,
    /className="hidden md:sticky md:top-\[92px\] md:grid md:grid-cols-1 md:gap-2"/
  );
  assert.match(SOURCE, /onChoose=\{chooseTab\}/);
  assert.match(SOURCE, /window\.history\.replaceState\(null, "", url\)/);
});

test("Canvas bottom padding keeps final controls above the phone dock", () => {
  const canvas = readFileSync(
    join(ROOT, "apps/dashboard/components/common/canvas.tsx"),
    "utf8"
  );
  assert.match(
    canvas,
    /pb-\[calc\(132px\+env\(safe-area-inset-bottom\)\)\]/
  );
  assert.match(canvas, /md:pb-\[120px\]/);
});

test("UI copy avoids em and en dashes in the settings mobile header", () => {
  const headerSlice = SOURCE.slice(
    SOURCE.indexOf("Back to Settings"),
    SOURCE.indexOf("Back to Settings") + 400
  );
  assert.equal(/[—–]/.test(headerSlice), false);
});
