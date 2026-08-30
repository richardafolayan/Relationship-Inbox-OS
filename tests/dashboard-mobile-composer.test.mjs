import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level guards for issue #900: compact mobile composer with
// progressive disclosure, draft height cap, and unchanged desktop chrome.
const src = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);

test("mobile default exposes only + / dictate / Send primary actions", () => {
  assert.match(src, /data-testid="composer-mobile-actions"/);
  assert.match(src, /data-testid="composer-more-toggle"/);
  assert.match(src, /data-testid="composer-mobile-send"/);
  const mobileBlock = src.slice(
    src.indexOf('data-testid="composer-mobile-actions"'),
    src.indexOf('data-testid="composer-mobile-send"') + 80
  );
  assert.match(mobileBlock, /Plus/);
  assert.match(
    mobileBlock,
    /aria-label=\{browserAudioCaptureAvailable \? "Dictate" : "Dictation unavailable"\}/
  );
  assert.doesNotMatch(mobileBlock, /Use keyboard microphone/);
  assert.match(mobileBlock, /Send/);
  assert.doesNotMatch(
    mobileBlock,
    /Suggested replies|shorten|Schedule send|Attach files|Record voice note/,
    "secondary labels must not sit in the mobile primary row"
  );
});

test("secondary mobile tools live in a viewport-bound action sheet", () => {
  assert.match(src, /composerMoreOpen/);
  assert.match(src, /title="Add to your reply"/);
  assert.match(src, /groups=\{mobileComposerGroups\}/);
  assert.match(src, /title="Suggested replies"/);
  assert.match(src, /title="Schedule send"/);
  assert.match(src, /label: "Photo or file"/);
  assert.match(src, /browserAudioCaptureAvailable[\s\S]*?\? "Voice note"[\s\S]*?: "Add voice recording"/);
  assert.match(src, /label: "Schedule send"/);
  assert.doesNotMatch(src, /data-testid="composer-more-sheet"/);
  assert.doesNotMatch(src, /chipsMenuMobileRef|scheduleMenuMobileRef/);
});

test("draft textarea uses the visual viewport and a smaller phone cap", () => {
  assert.match(src, /window\.visualViewport\?\.height \?\? window\.innerHeight/);
  assert.match(src, /phone \? 120 : 160/);
  assert.match(src, /phone \? 0\.22 : 0\.28/);
  assert.match(src, /max-h-\[120px\]/);
  assert.match(src, /overflow-y-auto/);
});

test("suggested draft has one calm mobile control", () => {
  const badgeIdx = src.indexOf('data-testid="ai-predraft-badge"');
  assert.notEqual(badgeIdx, -1);
  const badgeBlock = src.slice(badgeIdx, badgeIdx + 2000);
  assert.match(badgeBlock, />Suggested draft</);
  assert.match(badgeBlock, /\n\s*Discard\n/);
  assert.doesNotMatch(badgeBlock, /\n\s*Edit\n/);
});

test("desktop toolbar remains available at md+ and is not the mobile row", () => {
  assert.match(src, /className="desktop-ui-flex mt-1\.5 flex-wrap items-center gap-2"/);
  assert.match(src, /composer-mobile-actions"[\s\S]*?className="phone-ui-flex mt-1\.5 items-center gap-2"/);
});

test("thread switch closes the mobile more sheet", () => {
  const effectBodies = [
    ...src.matchAll(
      /useLayoutEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[composerAttachmentStore, threadId\]\)/g
    )
  ].map((m) => m[1]);
  const reset = effectBodies.find(
    (body) =>
      body.includes("setComposer(restoredIntent.text)") &&
      body.includes("setComposerMoreOpen(false)")
  );
  assert.ok(reset, "expected threadId reset to close composerMoreOpen");
  assert.match(reset, /setMobileSuggestionsOpen\(false\)/);
  assert.match(reset, /setMobileScheduleOpen\(false\)/);
});
