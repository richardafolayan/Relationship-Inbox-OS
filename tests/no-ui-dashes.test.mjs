import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the "no em/en dashes in user-facing UI copy" rule (see AGENTS.md).
// The class below holds an em dash (U+2014) and en dash (U+2013). This file
// lives in tests/, which the guard itself does not scan.
const DASH = /[—–]/;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo", "coverage"]);

// Pilot-facing and dev prose. Scanned whole, minus code blocks/spans.
const DOC_FILES = [
  "README.md",
  "AGENTS.md",
  "docs/strategy/current-product-direction.md",
  "docs/strategy/current-build-status.md",
  ...listFiles("docs/pilot", (name) => name.endsWith(".md"))
];

// UI source. Only rendered copy counts, so comments are stripped first;
// apps/runner/src is intentionally excluded (it is not user-facing copy).
const CODE_FILES = [
  ...listFiles("apps/dashboard", isSource),
  ...listFiles("packages", isSource)
];

function isSource(name) {
  return /\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts");
}

function listFiles(rel, keep) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(join(rel, entry.name), keep));
    } else if (keep(entry.name)) {
      out.push(join(rel, entry.name));
    }
  }
  return out;
}

// Blank out `//` and `/* */` comments, keeping one entry per source line.
function stripCodeComments(text) {
  let inBlock = false;
  return text.split("\n").map((line) => {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          i = line.length;
        } else {
          i = end + 2;
          inBlock = false;
        }
      } else if (line.startsWith("//", i)) {
        break;
      } else if (line.startsWith("/*", i)) {
        inBlock = true;
        i += 2;
      } else {
        out += line[i];
        i += 1;
      }
    }
    return out;
  });
}

// Blank out ``` fenced blocks and `inline code`, keeping one entry per line.
function stripDocCode(text) {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line.replace(/`[^`]*`/g, "");
  });
}

function scan(files, strip) {
  const hits = [];
  for (const rel of files) {
    strip(readFileSync(join(ROOT, rel), "utf8")).forEach((line, index) => {
      if (DASH.test(line)) hits.push(`${rel}:${index + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

test("no em/en dashes in active UI copy or pilot-facing docs", () => {
  const hits = [...scan(DOC_FILES, stripDocCode), ...scan(CODE_FILES, stripCodeComments)];
  assert.equal(
    hits.length,
    0,
    "Em/en dashes are not allowed in user-facing UI copy or pilot docs " +
      "(see AGENTS.md). Use commas, full stops, colons, brackets, slashes " +
      "or normal hyphens instead:\n" +
      hits.join("\n")
  );
});
