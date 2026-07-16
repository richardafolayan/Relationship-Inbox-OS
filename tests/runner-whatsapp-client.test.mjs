import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowsChromeExecutable } from "../apps/runner/dist/platforms/whatsapp/client.js";

test("WhatsApp uses the Windows Chrome installation already required by LinkedIn", () => {
  const localChrome = "C:\\Users\\student\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const programChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const existing = new Set([programChrome]);
  const resolved = resolveWindowsChromeExecutable(
    {
      LOCALAPPDATA: "C:\\Users\\student\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files"
    },
    "win32",
    (path) => existing.has(path)
  );

  assert.notEqual(resolved, localChrome);
  assert.equal(resolved, programChrome);
  assert.equal(resolveWindowsChromeExecutable({}, "darwin", () => true), undefined);
});
