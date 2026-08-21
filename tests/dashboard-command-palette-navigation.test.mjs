import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { activateCommandPaletteAction } = await import(
  "../apps/dashboard/lib/command-palette-action.ts"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const paletteSource = readFileSync(
  join(ROOT, "apps/dashboard/components/layout/command-palette.tsx"),
  "utf8"
);
const shellSource = readFileSync(
  join(ROOT, "apps/dashboard/components/layout/app-shell.tsx"),
  "utf8"
);

test("conversation selection navigates before closing Search", () => {
  const calls = [];

  activateCommandPaletteAction(
    { href: "/thread/lanre-thread-id" },
    {
      navigate: (href) => calls.push(["navigate", href]),
      close: () => calls.push(["close"])
    }
  );

  assert.deepEqual(calls, [
    ["navigate", "/thread/lanre-thread-id"],
    ["close"]
  ]);
});

test("page selection uses the same navigation path", () => {
  const calls = [];

  activateCommandPaletteAction(
    { href: "/inbox" },
    {
      navigate: (href) => calls.push(["navigate", href]),
      close: () => calls.push(["close"])
    }
  );

  assert.deepEqual(calls, [["navigate", "/inbox"], ["close"]]);
});

test("Reconnect is discoverable from desktop Search", () => {
  assert.match(
    paletteSource,
    /label:\s*"Go to Reconnect"[\s\S]*?href:\s*"\/reconnect"/
  );
});

test("desktop Search exposes a labelled combobox and selected listbox option", () => {
  assert.match(paletteSource, /role="combobox"/);
  assert.match(paletteSource, /aria-controls=\{listboxId\}/);
  assert.match(paletteSource, /aria-activedescendant=/);
  assert.match(paletteSource, /role="listbox"/);
  assert.match(paletteSource, /role="option"/);
  assert.match(paletteSource, /aria-selected=\{index === activeIndex\}/);
});

test("non-navigation actions still run before Search closes", () => {
  const calls = [];

  activateCommandPaletteAction(
    { run: () => calls.push(["run"]) },
    {
      navigate: (href) => calls.push(["navigate", href]),
      close: () => calls.push(["close"])
    }
  );

  assert.deepEqual(calls, [["run"], ["close"]]);
});

test("mouse click and Enter share the tested activation path", () => {
  assert.match(
    paletteSource,
    /event\.key === "Enter"[\s\S]*?activateItem\(target\)/,
    "Enter must activate the current result through the shared helper"
  );
  assert.match(
    paletteSource,
    /onClick=\{\(\) => activateItem\(item\)\}/,
    "mouse click must activate its result through the shared helper"
  );
  assert.match(paletteSource, /href:\s*`\/thread\/\$\{thread\.id\}`/);
  assert.match(paletteSource, /label:\s*"Go to Inbox"[\s\S]*?href:\s*"\/inbox"/);
});

test("app shell replaces the overlay marker for navigation", () => {
  assert.match(shellSource, /prepareNavigation:\s*preparePaletteNavigation/);
  assert.match(shellSource, /const mode = preparePaletteNavigation\(\)/);
  assert.match(shellSource, /router\[mode\]\(href\)/);
  assert.match(shellSource, /onNavigate=\{navigateFromPalette\}/);
});

test("desktop Search restores focus to its connected opener after close", () => {
  assert.match(shellSource, /paletteReturnFocusRef/);
  assert.match(shellSource, /document\.activeElement instanceof HTMLElement/);
  assert.match(shellSource, /if \(target\?\.isConnected\) target\.focus\(\)/);
});
