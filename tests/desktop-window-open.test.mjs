import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// R-0103 / #821, desktop layer. Photos and documents used to open via
// target="_blank" links, and the shell's window-open handler load-URL'd
// internal links OVER the main window — replacing the whole app with the
// raw file and no back button (the pilot escaped via the Settings menu
// item). The dashboard side now renders photos in an in-app viewer
// (photo-viewer.tsx, PR #841); this pins the desktop side: a window.open
// must never replace the app in the main window, whatever the target.
test("desktop window-open handler never loads a URL over the main window", async () => {
  const source = await readFile(
    new URL("../apps/desktop/main.cjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("setWindowOpenHandler");
  assert.ok(start > -1, "main.cjs should have a setWindowOpenHandler");
  const block = source.slice(start, source.indexOf("});", start));
  const codeLines = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"));
  assert.ok(
    codeLines.every((line) => !line.includes(".loadURL(")),
    "window.open must never replace the app in the main window (R-0103)"
  );
  // Everything safe goes to the default browser (which has its own
  // chrome), everything else is logged and dropped.
  assert.match(block, /openExternal/);
  assert.match(block, /action: "deny"/);
});
