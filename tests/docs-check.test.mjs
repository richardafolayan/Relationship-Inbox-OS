import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkDocumentation } from "../scripts/check-docs.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rios-doc-check-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { known: "node scripts/known.mjs", release: "node scripts/known.mjs" } })
  );
  writeFileSync(join(root, "scripts/known.mjs"), "\n");
  writeFileSync(join(root, "docs/target.md"), "# Existing heading\n");
  return root;
}

test("documentation check accepts valid links, anchors, scripts, flags, and paths", () => {
  const root = fixture();
  try {
    const guide = join(root, "docs/guide.md");
    writeFileSync(
      guide,
      "# Guide\n\n[Target](target.md#existing-heading)\n\n```bash\nnpm run known\nnode scripts/known.mjs\n```\n"
    );
    const result = checkDocumentation({
      root,
      markdownFiles: [guide, join(root, "docs/target.md")],
      requiredPaths: [],
      flagContracts: { release: ["--dry-run"] }
    });
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documentation check reports broken links, anchors, commands, flags, and command paths", () => {
  const root = fixture();
  try {
    const guide = join(root, "docs/guide.md");
    writeFileSync(
      guide,
      [
        "# Guide",
        "[Missing](missing.md)",
        "[Bad anchor](target.md#not-there)",
        "`npm run absent`",
        "`npm run release -- --not-a-flag`",
        "`node scripts/missing.mjs`"
      ].join("\n")
    );
    const result = checkDocumentation({
      root,
      markdownFiles: [guide, join(root, "docs/target.md")],
      requiredPaths: [],
      flagContracts: { release: ["--dry-run"] }
    });
    assert.deepEqual(
      new Set(result.errors.map((error) => error.code)),
      new Set(["broken-link", "broken-anchor", "stale-command", "stale-command-flag", "stale-command-path"])
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository documentation passes its own freshness check", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkDocumentation({ root });
  assert.deepEqual(result.errors, []);
});
