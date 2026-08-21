import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hookSource = await readFile(
  new URL("../apps/dashboard/lib/use-focus-window.ts", import.meta.url),
  "utf8"
);
const focusSource = await readFile(
  new URL("../apps/dashboard/components/settings/FocusSettingsSection.tsx", import.meta.url),
  "utf8"
);
const calendarSource = await readFile(
  new URL("../apps/dashboard/components/settings/CalendarFocusSection.tsx", import.meta.url),
  "utf8"
);

test("failed profile loads transition the shared hook to an explicit error state", () => {
  assert.match(hookSource, /setProfileLoadState\("ready"\)/);
  assert.match(
    hookSource,
    /\.catch\(\(\) => \{\s*if \(requestId === loadRequestRef\.current\) setProfileLoadState\("error"\)/
  );
});

test("Focus and Calendar replace editors with retry UI until a profile is ready", () => {
  for (const [name, source] of [
    ["Focus", focusSource],
    ["Calendar", calendarSource]
  ]) {
    assert.match(source, /if \(profileLoadState !== "ready"\)/, name);
    assert.match(source, /profileLoadState === "ready" && profile && !hydrated\.current/, name);
    assert.match(source, /onClick=\{reload\}/, name);
    assert.match(source, /Editing is paused/, name);
  }
});
