import test from "node:test";
import assert from "node:assert/strict";

const { paletteItemMatches } = await import("../apps/dashboard/lib/command-palette-search.ts");

// Mirror how command-palette.tsx builds a thread entry: the visible label
// truncates the preview to 60 chars, but `search` carries the full text.
function threadItem(personName, preview) {
  return {
    label: `${personName} - ${preview.slice(0, 60)}${preview.length > 60 ? "…" : ""}`,
    search: `${personName} ${preview}`
  };
}

// Issue #132. Brandon's latest message mentions "20-min" well past the
// 60-char label cut-off. Searching "20" must still find the thread.
test("#132: a number past the 60-char label is matched via the full preview", () => {
  const item = threadItem(
    "Brandon",
    "Hi — I wanted to flag a senior product role at a Series B fintech that looks aligned with your background. Quick 20-min chat this week?"
  );
  // The truncated label alone would miss it (this is the old bug):
  assert.equal(item.label.toLowerCase().includes("20"), false);
  // The full-preview search finds it:
  assert.equal(paletteItemMatches(item, "20"), true);
});

test("numbers anywhere in the name or preview are searchable (no digit stripping)", () => {
  assert.equal(paletteItemMatches(threadItem("Priya 07", "see you at 3pm"), "07"), true);
  assert.equal(paletteItemMatches(threadItem("Tom Hughes", "invoice #4471 is overdue"), "4471"), true);
  assert.equal(paletteItemMatches(threadItem("Nina", "call me on 020 7946 0991"), "7946"), true);
});

test("name and short-preview matching still works, case-insensitively", () => {
  const item = threadItem("Sophie Clarke", "thanks for the intro");
  assert.equal(paletteItemMatches(item, "sophie"), true);
  assert.equal(paletteItemMatches(item, "INTRO"), true);
  assert.equal(paletteItemMatches(item, "clarke"), true);
});

test("non-matching query returns false", () => {
  assert.equal(paletteItemMatches(threadItem("Brandon", "Quick 20-min chat?"), "99"), false);
  assert.equal(paletteItemMatches(threadItem("Brandon", "Quick 20-min chat?"), "zzz"), false);
});

test("page/action entries (no `search`) fall back to matching the label", () => {
  assert.equal(paletteItemMatches({ label: "Go to Settings" }, "settings"), true);
  assert.equal(paletteItemMatches({ label: "Run scan now" }, "scan"), true);
  assert.equal(paletteItemMatches({ label: "Go to Today" }, "inbox"), false);
});

test("empty / whitespace query matches everything (palette shows defaults)", () => {
  const item = threadItem("Brandon", "Quick 20-min chat?");
  assert.equal(paletteItemMatches(item, ""), true);
  assert.equal(paletteItemMatches(item, "   "), true);
});

// --- #819 (R-0101): WhatsApp directory entries in the palette ---

test("palette wires the WhatsApp directory: fetch, ranked-last items, keepOpen import", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../apps/dashboard/components/layout/command-palette.tsx", import.meta.url),
    "utf8"
  );
  // Fetches the directory of thread-less chats alongside the inbox index.
  assert.match(source, /\/runner\/data\/whatsapp\/directory/);
  // Selecting an entry imports the chat then navigates.
  assert.match(source, /\/runner\/control\/whatsapp\/open-chat/);
  // Directory entries rank after real threads so an existing conversation
  // always wins a name clash.
  assert.match(source, /\[\.\.\.pages, \.\.\.threadItems, \.\.\.directoryItems\]/);
  // The panel must stay open while the async import runs.
  assert.match(source, /keepOpen: true/);
  assert.match(source, /if \(!target\.keepOpen\) onClose\(\);/);
  assert.match(source, /if \(!item\.keepOpen\) onClose\(\);/);
});
