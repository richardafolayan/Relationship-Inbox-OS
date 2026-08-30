import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = [
  "../apps/dashboard/components/ui/button.tsx",
  "../apps/dashboard/app/thread/[id]/page.tsx",
  "../apps/dashboard/app/settings/page.tsx",
  "../apps/dashboard/components/common/GuidedTour.tsx",
  "../apps/dashboard/components/common/PilotTourInviteCard.tsx",
  "../apps/dashboard/components/common/SetupWizard.tsx",
  "../apps/dashboard/components/common/notification-cta.tsx",
  "../apps/dashboard/components/common/pilot-feedback-modal.tsx",
  "../apps/dashboard/components/common/toast-host.tsx",
  "../apps/dashboard/components/full-demo/FullDemoBanner.tsx",
  "../apps/dashboard/components/full-demo/FullDemoSettingsCard.tsx",
  "../apps/dashboard/components/settings/UserVoiceProfile.tsx",
  "../apps/dashboard/components/settings/WhatsAppConnect.tsx",
  "../apps/dashboard/components/thread/imessage-media.tsx",
  "../apps/dashboard/components/ui/menu.tsx"
];

test("primary button hovers stay theme-relative", async () => {
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8"))
  );

  for (const source of sources) {
    assert.doesNotMatch(source, /hover:bg-\[oklch\(28%_0\.01_80\)\]/);
  }
  assert.match(sources[0], /bg-ink text-paper hover:bg-ink-2/);
});

test("semantic status surfaces use dark-mode-aware tokens", async () => {
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8"))
  );
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /(?:bg|text|border|ring)-\[oklch/);
  assert.match(combined, /border-accent-ink\/50 text-accent-ink hover:bg-accent-soft/);
  assert.match(combined, /ring-risk-fresh\/40/);
  assert.match(combined, /bg-risk-waiting\/15/);
  assert.match(combined, /bg-transparent/);
});

test("dark theme overdue token is lighter than oxblood for text contrast", async () => {
  const css = await readFile(new URL("../apps/dashboard/app/globals.css", import.meta.url), "utf8");
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const darkMatch = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);

  assert.ok(rootMatch, "expected :root theme block");
  assert.ok(darkMatch, "expected [data-theme=\"dark\"] theme block");

  const rootBlock = rootMatch[1];
  const darkBlock = darkMatch[1];

  assert.match(rootBlock, /--risk-overdue:\s*var\(--accent\)/);
  assert.match(rootBlock, /--accent:\s*#9a2727/);
  assert.match(darkBlock, /--risk-overdue:\s*#df7676/);
  assert.doesNotMatch(darkBlock, /--risk-overdue:\s*var\(--accent\)/);
  assert.doesNotMatch(darkBlock, /--risk-overdue:\s*#9a2727/);
});
