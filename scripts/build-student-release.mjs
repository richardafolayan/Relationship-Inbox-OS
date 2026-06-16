#!/usr/bin/env node
//
// Relationship Inbox OS — student release builder.
//
// Produces a pilot-install source zip plus the latest.json the updater reads.
// Run it from a checkout of the branch you want to release (normally
// v1/strip-back-pr1):
//
//   npm run build:student-release
//   npm run build:student-release -- --zip-url "https://www.dropbox.com/...?dl=1"
//
// The zip contains only git-TRACKED files (so .env, data/, logs, the SQLite
// database and node_modules can never leak — they are gitignored and never
// tracked), with a generated release.json baked in. It carries NO high-value
// secrets, no user data, no AI keys, and no Dropbox tokens.
//
// The ONE exception is the low-value, rotatable pilot-feedback token
// (PILOT_FEEDBACK_WEBHOOK_URL / _SECRET / _STATUS_URL): when those are provided
// at release time (via env or a gitignored .env.release.local — never
// committed) they are baked into the shipped .env.example so a fresh install's
// in-app "Report a bug / Share feedback" reaches your Google Sheet. A path scan
// hard-fails on forbidden files, and a CONTENT scan hard-fails if any OTHER
// secret-like value lands in .env.example. To ROTATE the feedback secret:
// change it in the Apps Script, update .env.release.local + the GitHub secret,
// and republish.
//
// Real-world flow (see docs/pilot/releasing-student-builds.md):
//   1. Build:    npm run build:student-release
//   2. Upload    relationship-inbox-os-student-latest.zip to Dropbox.
//   3. Manifest: npm run build:student-release -- --manifest-only \
//                  --zip-url "https://www.dropbox.com/...?dl=1"
//   4. Upload    latest.json to Dropbox.
//
// Flags:
//   --zip-url <url>     Dropbox (dl=1) URL of the uploaded zip, written into latest.json
//   --ref <git-ref>     git ref to archive (default: HEAD)
//   --out <dir>         output directory (default: release-dist/)
//   --notes <line>      a release-note line (repeatable)
//   --notes-file <path> read release notes from a file (one per line)
//   --min-installer <v> minimumInstallerVersion in latest.json (default: package version)
//   --manifest-only     do not rebuild the zip; just (re)write latest.json from an existing zip
//   --zip <path>        which zip to checksum in --manifest-only mode (default: the -latest zip)

import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bakePilotEnv, findEnvExampleSecretLeaks, findForbiddenEntries, sha256File
} from "./lib/release-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_FOLDER_NAME = "relationship-inbox-os";

// Load env + an optional gitignored .env.release.local (real env wins),
// mirroring publish-student-release.mjs so a direct `build:student-release`
// run also picks up release config. RIOS_RELEASE_ENV_FILE overrides the path
// (keeps tests isolated from a developer's real .env.release.local).
function loadReleaseEnv() {
  const file = process.env.RIOS_RELEASE_ENV_FILE || join(ROOT, ".env.release.local");
  const env = { ...process.env };
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (env[key] === undefined) env[key] = val; // real env wins
    }
  }
  return env;
}

// Bake the pilot distribution config (update feed link + feedback token) into
// the staged .env.example (the installer copies it to .env), then hard-fail
// if any OTHER secret rode along. Uses the pure helpers from
// release-manifest.mjs so the logic is unit-tested.
function bakeAndGuardEnvExample(appDir) {
  const file = join(appDir, ".env.example");
  if (!existsSync(file)) return [];
  const { text, injected } = bakePilotEnv(readFileSync(file, "utf8"), loadReleaseEnv());
  if (injected.length) writeFileSync(file, text);
  const leaks = findEnvExampleSecretLeaks(readFileSync(file, "utf8"));
  if (leaks.length) {
    die(
      "Refusing to build — .env.example carries non-blank secret values that aren't the\n" +
      `   allowed pilot distribution config:\n   ${leaks.join("\n   ")}`
    );
  }
  return injected;
}

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--zip-url") out.zipUrl = next();
    else if (a === "--ref") out.ref = next();
    else if (a === "--out") out.out = next();
    else if (a === "--notes") out.notes.push(next());
    else if (a === "--notes-file") out.notesFile = next();
    else if (a === "--min-installer") out.minInstaller = next();
    else if (a === "--manifest-only") out.manifestOnly = true;
    else if (a === "--zip") out.zip = next();
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
  process.exit(0);
}

const OUT_DIR = resolve(ROOT, args.out || "release-dist");
const REF = args.ref || "HEAD";
const PLACEHOLDER_URL = "https://REPLACE-WITH-DROPBOX-DIRECT-LINK?dl=1";

function git(...a) {
  return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
}
function pkgVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}
function pkgVersionFromRef(ref) {
  const pkg = JSON.parse(git("show", `${ref}:package.json`));
  if (!pkg.version) die(`package.json at ${ref} does not have a version.`);
  return pkg.version;
}
function die(msg) {
  process.stderr.write(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full));
  }
  return acc;
}

function readNotes(version) {
  if (args.notesFile) {
    return readFileSync(resolve(ROOT, args.notesFile), "utf8")
      .split(/\r?\n/).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  }
  if (args.notes.length) return args.notes;
  return [`Student pilot build ${version}.`];
}

function writeManifest({ version, build, commit, zipPath, sha256 }) {
  const zipUrl = args.zipUrl || PLACEHOLDER_URL;
  const manifest = {
    version,
    build,
    commit,
    zipUrl,
    sha256,
    releaseNotes: readNotes(version),
    minimumInstallerVersion: args.minInstaller || version
  };
  const manifestPath = join(OUT_DIR, "latest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const shaPath = `${zipPath}.sha256`;
  writeFileSync(shaPath, `${sha256}  ${join(zipPath).split("/").pop()}\n`);
  return { manifestPath, shaPath, zipUrl, manifest };
}

// ---- manifest-only: regenerate latest.json from an existing zip ----------
async function manifestOnly() {
  mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = args.zip
    ? resolve(ROOT, args.zip)
    : join(OUT_DIR, `${APP_FOLDER_NAME}-student-latest.zip`);
  if (!existsSync(zipPath)) die(`No zip to checksum at ${zipPath}. Build a release first, or pass --zip.`);
  const sha256 = await sha256File(zipPath);

  // Describe the ACTUAL zip: read the version/build/commit baked into its
  // release.json so re-stamping the Dropbox URL never drifts the metadata.
  let version = pkgVersion();
  let build = new Date().toISOString();
  let commit = "";
  try {
    const baked = JSON.parse(
      execFileSync("unzip", ["-p", zipPath, `${APP_FOLDER_NAME}/release.json`], { encoding: "utf8" })
    );
    if (baked.version) version = baked.version;
    if (baked.build) build = baked.build;
    if (baked.commit) commit = String(baked.commit).slice(0, 7);
  } catch {
    try { commit = git("rev-parse", "--short", REF); } catch { /* not a git checkout */ }
  }
  const { manifestPath, zipUrl } = writeManifest({ version, build, commit, zipPath, sha256 });

  process.stdout.write(`\n  Regenerated manifest only.\n`);
  process.stdout.write(`  latest.json : ${manifestPath}\n`);
  process.stdout.write(`  zip         : ${zipPath}\n`);
  process.stdout.write(`  sha256      : ${sha256}\n`);
  if (zipUrl === PLACEHOLDER_URL) {
    process.stdout.write(`\n  ! zipUrl is still a placeholder. Pass --zip-url "<dropbox dl=1 link>".\n`);
  }
  process.stdout.write("\n");
}

// ---- full build ----------------------------------------------------------
async function build() {
  const version = pkgVersionFromRef(REF);
  const build = new Date().toISOString();
  const commit = git("rev-parse", "--short", REF);
  const fullCommit = git("rev-parse", REF);

  process.stdout.write(`\n  Building student release ${version} (${commit}) from ${REF}\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "rios-release-"));
  const appDir = join(staging, APP_FOLDER_NAME);
  mkdirSync(appDir, { recursive: true });

  try {
    // 1. Export only git-tracked files (inherently excludes secrets/data/node_modules).
    const tarPath = join(staging, "src.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", tarPath, REF], { cwd: ROOT });
    execFileSync("tar", ["-xf", tarPath, "-C", appDir]);
    rmSync(tarPath, { force: true });

    // 2. Bake a release.json so the installed app knows what it is.
    writeFileSync(
      join(appDir, "release.json"),
      JSON.stringify({ version, build, commit: fullCommit, channel: "student" }, null, 2) + "\n"
    );

    // 2b. Bake the pilot-feedback token into .env.example (if provided at
    // release time), then hard-fail if any OTHER secret value rode along.
    const injected = bakeAndGuardEnvExample(appDir);
    if (injected.length) {
      process.stdout.write(`  Baked pilot config into .env.example (${injected.join(", ")}).\n`);
    } else {
      process.stdout.write(`  ! No pilot-feedback config provided — in-app feedback will be OFF for pilots.\n`);
    }

    // 3. Belt-and-braces: scan the staged tree for anything forbidden.
    const staged = walk(appDir).map((p) => `${APP_FOLDER_NAME}/${p}`);
    const leaked = findForbiddenEntries(staged);
    if (leaked.length) {
      die(`Refusing to build — forbidden files in the release:\n   ${leaked.slice(0, 20).join("\n   ")}`);
    }

    // 4. Zip (top-level relationship-inbox-os/ folder). -X drops macOS extras.
    const versionedZip = join(OUT_DIR, `${APP_FOLDER_NAME}-student-${version}.zip`);
    const latestZip = join(OUT_DIR, `${APP_FOLDER_NAME}-student-latest.zip`);
    rmSync(versionedZip, { force: true });
    execFileSync("zip", ["-r", "-X", "-q", versionedZip, APP_FOLDER_NAME], { cwd: staging });

    // 5. Re-scan the ACTUAL zip entries — catch anything zip added.
    const zipEntries = execFileSync("unzip", ["-Z1", versionedZip], { encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const zipLeaked = findForbiddenEntries(zipEntries);
    if (zipLeaked.length) {
      rmSync(versionedZip, { force: true });
      die(`Refusing to publish — forbidden files inside the zip:\n   ${zipLeaked.slice(0, 20).join("\n   ")}`);
    }

    // 6. latest copy + checksum + manifest.
    cpSync(versionedZip, latestZip);
    const sha256 = await sha256File(versionedZip);
    const { manifestPath, shaPath, zipUrl } = writeManifest({ version, build, commit, zipPath: versionedZip, sha256 });

    const sizeMb = (statSync(versionedZip).size / (1024 * 1024)).toFixed(1);
    process.stdout.write(`\n  Built (${sizeMb} MB, ${zipEntries.length} files):\n`);
    process.stdout.write(`    zip (versioned) : ${versionedZip}\n`);
    process.stdout.write(`    zip (latest)    : ${latestZip}\n`);
    process.stdout.write(`    checksum        : ${shaPath}\n`);
    process.stdout.write(`    manifest        : ${manifestPath}\n`);
    process.stdout.write(`    sha256          : ${sha256}\n`);
    process.stdout.write(`\n  Next:\n`);
    process.stdout.write(`    1. Upload ${APP_FOLDER_NAME}-student-latest.zip to Dropbox.\n`);
    process.stdout.write(`    2. Copy its share link and change dl=0 to dl=1.\n`);
    process.stdout.write(`    3. npm run build:student-release -- --manifest-only --zip-url "<that dl=1 link>"\n`);
    process.stdout.write(`    4. Upload latest.json to Dropbox (use raw=1 or dl=1 for its link).\n`);
    if (zipUrl === PLACEHOLDER_URL) {
      process.stdout.write(`\n  ! latest.json zipUrl is a placeholder until you run step 3.\n`);
    }
    process.stdout.write(`\n  See docs/pilot/releasing-student-builds.md for the full walk-through.\n\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

(args.manifestOnly ? manifestOnly() : build()).catch((err) => die(err?.message || String(err)));
