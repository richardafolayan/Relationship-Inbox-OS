#!/usr/bin/env node
// Post-build step. tsc compiles our `from "./db"` source imports as
// extensionless `from "./db"` in dist — fine for `tsx watch` (it has its
// own resolver) but rejected by `node` when the package is `"type":
// "module"` because the ESM loader requires explicit `.js` extensions on
// relative imports.
//
// This script walks dist/, finds every relative-import specifier without
// an extension, and rewrites it to add `.js` (or `.../index.js` if the
// target is a directory). It's idempotent — running it twice is a no-op.
//
// We chose this approach over `tsc-alias` to avoid adding a new
// devDependency for ~40 lines of behaviour, and over migrating the source
// to `module: "NodeNext"` (which would force every internal import in
// every file to grow a `.js` suffix).

import { promises as fs } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile() && (fullPath.endsWith(".js") || fullPath.endsWith(".mjs"))) {
      files.push(fullPath);
    }
  }
  return files;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpecifier(fileDir, spec) {
  // Only relative specifiers (./ ../). Bare imports stay untouched.
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    return spec;
  }
  // Already has a .js / .mjs / .json extension.
  if (/\.(js|mjs|cjs|json)$/.test(spec)) {
    return spec;
  }
  const candidatePath = resolve(fileDir, spec);
  // First try `<spec>.js`.
  if (await exists(`${candidatePath}.js`)) {
    return `${spec}.js`;
  }
  // Then try `<spec>/index.js` (CommonJS-style barrel).
  if (await exists(join(candidatePath, "index.js"))) {
    return `${spec}/index.js`;
  }
  // Couldn't find a target — leave it. tsc would have errored if the
  // source itself was broken; this means the spec is something exotic
  // we don't need to rewrite.
  return spec;
}

async function rewriteFile(filePath) {
  const original = await fs.readFile(filePath, "utf8");
  const fileDir = dirname(filePath);
  // Match both `import ... from "..."` and `import("...")`. Also covers
  // `export ... from "..."` re-exports.
  const importRegex = /(\bfrom\s+|\bimport\(\s*)(['"])(\.\.?\/[^'"]*?)\2/g;
  const replacements = [];
  for (const match of original.matchAll(importRegex)) {
    replacements.push(match);
  }
  if (replacements.length === 0) {
    return false;
  }
  let updated = "";
  let cursor = 0;
  for (const match of replacements) {
    const [whole, prefix, quote, spec] = match;
    const newSpec = await resolveSpecifier(fileDir, spec);
    if (newSpec === spec) {
      continue;
    }
    const startIndex = match.index ?? 0;
    updated += original.slice(cursor, startIndex);
    updated += `${prefix}${quote}${newSpec}${quote}`;
    cursor = startIndex + whole.length;
  }
  if (cursor === 0) {
    return false;
  }
  updated += original.slice(cursor);
  await fs.writeFile(filePath, updated, "utf8");
  return true;
}

async function main() {
  if (!(await exists(distDir))) {
    console.error(`add-js-extensions: ${distDir} does not exist (run tsc first)`);
    process.exit(1);
  }
  const files = await walk(distDir);
  let changed = 0;
  for (const file of files) {
    if (await rewriteFile(file)) {
      changed += 1;
    }
  }
  console.log(`add-js-extensions: rewrote ${changed} of ${files.length} files`);
}

main().catch((error) => {
  console.error("add-js-extensions failed:", error);
  process.exit(1);
});
