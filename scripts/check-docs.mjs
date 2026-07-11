#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_REFERENCE_PATHS = [
  ".env.example",
  "package.json",
  "apps/dashboard/package.json",
  "apps/runner/package.json",
  "packages/core/package.json",
  "packages/core/prisma/schema.prisma",
  "docs/index.md",
  "docs/architecture/overview.md",
  "docs/architecture/message-lifecycle.md",
  "docs/user/install.md",
  "docs/user/guide.md",
  "docs/operations/runbook.md",
  "docs/operations/releases.md",
  "docs/developer/repository.md",
  "docs/developer/features.md",
  "docs/developer/platform-adapters.md",
  "docs/developer/data-and-storage.md",
  "docs/developer/configuration.md",
  "docs/developer/ai.md",
  "docs/developer/testing.md",
  "docs/troubleshooting/playbook.md",
  "docs/adr/README.md"
];

export const SCRIPT_FLAG_CONTRACTS = {
  "install:student": ["--dry-run", "--no-start", "--skip-deps", "--help"],
  "update:student": [
    "--check-only",
    "--apply",
    "--dry-run",
    "--url",
    "--dir",
    "--no-deps",
    "--keep-backups",
    "--json",
    "--help"
  ],
  "build:student-release": [
    "--zip-url",
    "--ref",
    "--out",
    "--notes",
    "--notes-file",
    "--min-installer",
    "--manifest-only",
    "--zip",
    "--help"
  ],
  "publish:student-release": [
    "--dry-run",
    "--skip-build",
    "--print-links",
    "--notes",
    "--notes-file",
    "--help"
  ],
  "build:macos-dmg": [
    "--out",
    "--ref",
    "--node-dir",
    "--skip-install",
    "--skip-build",
    "--skip-dmg",
    "--no-sign",
    "--dry-run",
    "--help"
  ],
  "create:macos-app": [
    "--app-dir",
    "--out",
    "--node-dir",
    "--bundle-id",
    "--dry-run",
    "--help"
  ],
  "cleanup:artifacts": ["--apply"]
};

function walkMarkdown(directory, output) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkMarkdown(path, output);
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
  }
}

export function findMarkdownFiles(root = ROOT) {
  const files = [];
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.push(readme);
  walkMarkdown(join(root, "docs"), files);
  return files.sort();
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function githubSlug(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsFor(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = githubSlug(heading[2]);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/<(?:a|span)\s+(?:[^>]*?\s)?(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function normalizeLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    target = end === -1 ? target.slice(1) : target.slice(1, end);
  } else {
    target = target.split(/\s+["']/)[0];
  }
  return target;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maskFencedCode(markdown) {
  let inFence = false;
  return markdown
    .split(/(?<=\n)/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line.replace(/[^\n]/g, " ");
      }
      return inFence ? line.replace(/[^\n]/g, " ") : line;
    })
    .join("");
}

function linkErrors({ root, file, text, anchorCache }) {
  const errors = [];
  const destinations = [];
  const linkText = maskFencedCode(text);
  const inline = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const references = /^\s*\[[^\]]+\]:\s+(\S+)/gm;
  for (const match of linkText.matchAll(inline)) destinations.push({ raw: match[1], index: match.index });
  for (const match of linkText.matchAll(references)) destinations.push({ raw: match[1], index: match.index });

  for (const { raw, index } of destinations) {
    const target = normalizeLinkTarget(raw);
    if (!target || isExternal(target)) continue;
    const hashAt = target.indexOf("#");
    const queryAt = target.indexOf("?");
    const pathEnd = [hashAt, queryAt].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? target.length;
    const pathPart = decodePath(target.slice(0, pathEnd));
    const rawAnchor = hashAt >= 0 ? target.slice(hashAt + 1).split("?")[0] : "";
    const anchor = decodePath(rawAnchor).replace(/^user-content-/, "").toLowerCase();
    const resolved = pathPart
      ? resolve(pathPart.startsWith("/") ? root : dirname(file), pathPart.replace(/^\/+/, ""))
      : file;
    const shown = relative(root, file);
    if (!existsSync(resolved)) {
      errors.push({
        file: shown,
        line: lineNumber(text, index),
        code: "broken-link",
        message: `missing local target ${JSON.stringify(target)}`
      });
      continue;
    }
    if (statSync(resolved).isDirectory()) continue;
    const targetFile = resolved;
    if (!anchor || !targetFile.endsWith(".md") || /^l\d+(?:-l\d+)?$/i.test(anchor)) continue;
    let anchors = anchorCache.get(targetFile);
    if (!anchors) {
      anchors = anchorsFor(readFileSync(targetFile, "utf8"));
      anchorCache.set(targetFile, anchors);
    }
    if (!anchors.has(anchor)) {
      errors.push({
        file: shown,
        line: lineNumber(text, index),
        code: "broken-anchor",
        message: `missing #${anchor} in ${relative(root, targetFile)}`
      });
    }
  }
  return errors;
}

function loadPackageScripts(root) {
  const packages = new Map();
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packages.set("<root>", new Set(Object.keys(rootPackage.scripts ?? {})));
  const workspacePatterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  for (const pattern of workspacePatterns) {
    if (!pattern.endsWith("/*")) continue;
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packagePath = join(parent, entry.name, "package.json");
      if (!existsSync(packagePath)) continue;
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (pkg.name) packages.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
    }
  }
  return packages;
}

function commandErrors({ root, file, text, packageScripts, flagContracts }) {
  const errors = [];
  const shown = relative(root, file);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(/npm\s+run\s+([a-zA-Z0-9_.:-]+)/g)) {
      const script = match[1];
      const tail = line.slice((match.index ?? 0) + match[0].length);
      const workspaceMatch = /--workspace(?:=|\s+)([^\s`]+)/.exec(tail);
      const workspace = workspaceMatch?.[1]?.replace(/[),.;]+$/, "") ?? "<root>";
      const scripts = packageScripts.get(workspace);
      if (!scripts) {
        errors.push({
          file: shown,
          line: index + 1,
          code: "unknown-workspace",
          message: `documented workspace ${workspace} does not exist`
        });
      } else if (!scripts.has(script)) {
        errors.push({
          file: shown,
          line: index + 1,
          code: "stale-command",
          message: `npm script ${script} does not exist in ${workspace}`
        });
      }

      const separator = tail.indexOf(" -- ");
      const allowed = flagContracts[script];
      if (separator >= 0 && allowed) {
        const scriptArgs = tail.slice(separator + 4);
        for (const flag of scriptArgs.match(/--[a-z][a-z0-9-]*/g) ?? []) {
          if (!allowed.includes(flag)) {
            errors.push({
              file: shown,
              line: index + 1,
              code: "stale-command-flag",
              message: `${script} does not support documented flag ${flag}`
            });
          }
        }
      }
    }

    for (const match of line.matchAll(/(?:^|[\s`])(?:node|bash)\s+((?:\.\/)?(?:scripts|apps|packages)\/[^\s`"'<>|;&]+)/g)) {
      const rawPath = match[1].replace(/[),.:]+$/, "");
      const commandPath = resolve(root, rawPath.replace(/^\.\//, ""));
      if (!existsSync(commandPath)) {
        errors.push({
          file: shown,
          line: index + 1,
          code: "stale-command-path",
          message: `documented command target does not exist: ${rawPath}`
        });
      }
    }
  }
  return errors;
}

export function checkDocumentation(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const markdownFiles = options.markdownFiles ?? findMarkdownFiles(root);
  const requiredPaths = options.requiredPaths ?? REQUIRED_REFERENCE_PATHS;
  const flagContracts = options.flagContracts ?? SCRIPT_FLAG_CONTRACTS;
  const errors = [];
  const anchorCache = new Map();
  let packageScripts;
  try {
    packageScripts = loadPackageScripts(root);
  } catch (error) {
    errors.push({
      file: "package.json",
      line: 1,
      code: "package-read",
      message: error instanceof Error ? error.message : String(error)
    });
    packageScripts = new Map([["<root>", new Set()]]);
  }

  for (const required of requiredPaths) {
    if (!existsSync(resolve(root, required))) {
      errors.push({
        file: required,
        line: 1,
        code: "missing-reference-file",
        message: "required documentation/source reference is missing"
      });
    }
  }

  for (const file of markdownFiles) {
    const text = readFileSync(file, "utf8");
    errors.push(...linkErrors({ root, file, text, anchorCache }));
    errors.push(...commandErrors({ root, file, text, packageScripts, flagContracts }));
  }

  errors.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)
  );
  return { root, markdownFiles, errors };
}

function main() {
  const json = process.argv.includes("--json");
  const result = checkDocumentation();
  if (json) {
    process.stdout.write(`${JSON.stringify({ files: result.markdownFiles.length, errors: result.errors }, null, 2)}\n`);
  } else if (result.errors.length === 0) {
    process.stdout.write(`Documentation checks passed (${result.markdownFiles.length} Markdown files).\n`);
  } else {
    for (const error of result.errors) {
      process.stderr.write(`${error.file}:${error.line} [${error.code}] ${error.message}\n`);
    }
    process.stderr.write(`Documentation checks failed with ${result.errors.length} error(s).\n`);
  }
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) main();
