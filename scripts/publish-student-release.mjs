#!/usr/bin/env node
//
// Tovi — publish a student release to Dropbox.
//
// One safe command that: builds the release, refuses to publish if anything
// secret would leak, OVERWRITES the same two files in Dropbox (so the share
// links — and the pilots' RIOS_UPDATE_FEED_URL — stay stable), then verifies
// the live feed end to end (JSON, version, and a re-downloaded zip whose
// sha256 matches the manifest). It fails loudly at the first problem.
//
//   npm run publish:student-release
//   npm run publish:student-release -- --dry-run        # build + verify locally, upload nothing
//   npm run publish:student-release -- --notes "..."    # release notes (repeatable)
//
// Configuration comes from the environment (or a gitignored .env.release.local
// in the repo root). NOTHING is hard-coded; no token or link lives in source.
//
//   Auth (one of):
//     DROPBOX_ACCESS_TOKEN                 a (short-lived) Dropbox access token, OR
//     DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET
//                                          (preferred for CI: exchanged for an
//                                          access token at run time)
//   Dropbox file paths (what gets overwritten):
//     RIOS_DROPBOX_ZIP_PATH                e.g. /Relationship Inbox OS Pilot Releases/relationship-inbox-os-student-latest.zip
//     RIOS_DROPBOX_MANIFEST_PATH           e.g. /Relationship Inbox OS Pilot Releases/latest.json
//   Stable public share links (created ONCE, reused every release):
//     RIOS_DROPBOX_ZIP_URL                 the zip's dl=1 share link (baked into latest.json)
//     RIOS_UPDATE_FEED_URL                 the manifest's raw=1 share link (the pilots' feed)
//
// Flags:
//   --dry-run            build + manifest + safety checks; upload nothing
//   --skip-build         publish the existing release-dist/ artefacts as-is
//   --print-links        one-time setup: print stable (no-`st=`) share links
//                        for the configured paths, then exit (uploads nothing)
//   --notes <line>       a release-note line (repeatable)
//   --notes-file <path>  read release notes from a file
//   --help

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenEntries, sha256Buffer, sha256File, validateLatestJson } from "./lib/release-manifest.mjs";
import { resolveAppName } from "./lib/branding.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = resolveAppName();
const RELEASE_DIR = join(ROOT, "release-dist");
const LATEST_ZIP = join(RELEASE_DIR, "relationship-inbox-os-student-latest.zip");
const MANIFEST = join(RELEASE_DIR, "latest.json");

// Dropbox API hosts. Overridable ONLY so the test suite can point the whole
// flow at a localhost mock; production always uses the real hosts.
const DBX_API = process.env.RIOS_DROPBOX_API_BASE || "https://api.dropboxapi.com";
const DBX_CONTENT = process.env.RIOS_DROPBOX_CONTENT_BASE || "https://content.dropboxapi.com";

const C = process.stdout.isTTY
  ? { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", reset: "\x1b[0m" }
  : { b: "", d: "", g: "", y: "", r: "", reset: "" };
const say = (m) => process.stdout.write(m + "\n");
const step = (m) => say(`\n${C.b}▸ ${m}${C.reset}`);
const ok = (m) => say(`  ${C.g}✓${C.reset} ${m}`);
function die(m) {
  process.stderr.write(`\n  ${C.r}✗ publish failed: ${m}${C.reset}\n\n`);
  process.exit(1);
}

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const out = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-build") out.skipBuild = true;
    else if (a === "--print-links") out.printLinks = true;
    else if (a === "--notes") out.notes.push(next());
    else if (a === "--notes-file") out.notesFile = next();
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  say(readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

// ---- config (env + optional .env.release.local) --------------------------
function loadConfig() {
  // Path overridable via RIOS_RELEASE_ENV_FILE so tests stay isolated from a
  // real .env.release.local a developer may have on disk.
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
const env = loadConfig();

function requireVars(names) {
  const missing = names.filter((n) => !String(env[n] || "").trim());
  if (missing.length) {
    die(`missing required config: ${missing.join(", ")}\n` +
      `  Set them in the environment or a gitignored .env.release.local.\n` +
      `  See docs/pilot/automated-release-publishing.md.`);
  }
}

// ---- Dropbox API ---------------------------------------------------------
async function dropboxAccessToken() {
  if (String(env.DROPBOX_ACCESS_TOKEN || "").trim()) {
    return env.DROPBOX_ACCESS_TOKEN.trim();
  }
  requireVars(["DROPBOX_REFRESH_TOKEN", "DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"]);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN.trim(),
    client_id: env.DROPBOX_APP_KEY.trim(),
    client_secret: env.DROPBOX_APP_SECRET.trim(),
  });
  const res = await fetch(`${DBX_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) die(`Dropbox token refresh failed (${res.status}). Check DROPBOX_REFRESH_TOKEN / APP_KEY / APP_SECRET.`);
  const json = await res.json().catch(() => null);
  if (!json?.access_token) die("Dropbox token refresh returned no access_token.");
  return json.access_token;
}

async function dropboxRpc(token, endpoint, body) {
  const res = await fetch(`${DBX_API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// Resolve a STABLE, never-expiring direct-download link for a Dropbox path via
// the sharing API. These links carry no ephemeral `st=` token (unlike links
// copied from the Dropbox website), so they're the durable choice for the
// pilot feed. Idempotent: create, and on shared_link_already_exists reuse the
// existing one (needs sharing.write + sharing.read).
async function resolveSharedLink(token, dropboxPath, mode /* "dl" | "raw" */) {
  let url = null;
  // Ask for a public link explicitly so visibility doesn't default to a
  // team/account policy (which could make the pilot feed non-public).
  const created = await dropboxRpc(token, "/2/sharing/create_shared_link_with_settings", {
    path: dropboxPath,
    settings: { requested_visibility: "public" },
  });
  if (created.ok && created.json?.url) {
    url = created.json.url;
  } else if (created.json?.error?.[".tag"] === "shared_link_already_exists") {
    const meta = created.json.error.shared_link_already_exists?.metadata;
    if (meta?.url) {
      url = meta.url;
    } else {
      const listed = await dropboxRpc(token, "/2/sharing/list_shared_links", { path: dropboxPath, direct_only: true });
      url = listed.json?.links?.[0]?.url ?? null;
    }
  }
  if (!url) die(`could not get a shared link for ${dropboxPath} (${created.status}). ${created.text.slice(0, 200)}`);
  // Drop the download-mode params AND the ephemeral `st=` token (a mode hint,
  // not auth — `rlkey` is the access key), then set an explicit direct param.
  // Parsed with the URL API so it's correct regardless of param order.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    die(`Dropbox returned a shared link that isn't a valid URL: ${url.slice(0, 120)}`);
  }
  parsed.searchParams.delete("dl");
  parsed.searchParams.delete("raw");
  parsed.searchParams.delete("st");
  parsed.searchParams.set(mode, "1");
  return parsed.toString();
}

async function dropboxUploadOverwrite(token, dropboxPath, bytes) {
  // mode=overwrite modifies the file IN PLACE: Dropbox keeps the file's id
  // (bumps the rev, old bytes go to version history). Because a /scl/fi/<id>
  // shared link is bound to that file id, the EXISTING public link keeps
  // resolving and now serves the new content — this is the stable-URL
  // property the whole pilot feed depends on. NEVER delete + recreate the
  // file (that changes the id and breaks every pilot's RIOS_UPDATE_FEED_URL).
  const res = await fetch(`${DBX_CONTENT}/2/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: dropboxPath, mode: "overwrite", mute: true, autorename: false, strict_conflict: false,
      }),
    },
    body: bytes,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    die(`Dropbox upload failed for ${dropboxPath} (${res.status}). ${detail.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// ---- helpers -------------------------------------------------------------
function buildArgs() {
  const a = [];
  for (const n of args.notes) a.push("--notes", n);
  if (args.notesFile) a.push("--notes-file", args.notesFile);
  return a;
}

function runBuild() {
  step("Building the student release");
  execFileSync(process.execPath, [join(ROOT, "scripts/build-student-release.mjs"), ...buildArgs()],
    { cwd: ROOT, stdio: "inherit" });
}

function zipEntries(zipPath) {
  return execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function assertNoLeaks(zipPath) {
  step("Safety check (no secrets / data in the zip)");
  if (!existsSync(zipPath)) die(`built zip not found at ${zipPath}. Run without --skip-build.`);
  const leaked = findForbiddenEntries(zipEntries(zipPath));
  if (leaked.length) {
    die(`forbidden files inside the release zip — refusing to publish:\n   ${leaked.slice(0, 20).join("\n   ")}`);
  }
  ok(`zip is clean (${zipEntries(zipPath).length} files)`);
}

function regenerateManifest(stableZipUrl) {
  step("Generating latest.json with the stable zip link");
  // Forward --notes/--notes-file so the manifest keeps the release notes (a
  // bare --manifest-only would reset them to the default).
  execFileSync(process.execPath, [
    join(ROOT, "scripts/build-student-release.mjs"),
    "--manifest-only", "--zip", LATEST_ZIP, "--zip-url", stableZipUrl, ...buildArgs(),
  ], { cwd: ROOT, stdio: "inherit" });
  if (!existsSync(MANIFEST)) die("latest.json was not generated.");
}

function looksLikeHtml(buf) {
  // A real zip starts with "PK"; a real manifest is JSON. Anything that begins
  // with markup (HTML/XML error pages, Dropbox interstitials) is not what we
  // want — flag any leading "<". (Non-markup error bodies are still caught by
  // the JSON-parse / sha256 checks downstream.)
  const head = buf.slice(0, 200).toString("utf8").trimStart();
  return head.startsWith("<");
}

// Throws (rather than die) so the verify retry loop can re-attempt transient
// failures; the loop ultimately fails loudly if they persist.
async function fetchBuffer(url, what) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new Error(`could not fetch ${what}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Fetch the LIVE feed + zip and check they match what we just built. Throws on
// any mismatch so the caller can retry (Dropbox can take a moment to serve new
// content) and ultimately fail loudly.
async function verifyLiveFeed(expected) {
  const feedBuf = await fetchBuffer(env.RIOS_UPDATE_FEED_URL.trim(), "the update feed");
  if (looksLikeHtml(feedBuf)) {
    throw new Error("the feed URL returned a web page, not JSON (it must be a Dropbox raw=1 or dl=1 link)");
  }
  let live;
  try {
    live = JSON.parse(feedBuf.toString("utf8"));
  } catch {
    throw new Error("the live feed was not valid JSON");
  }
  const lv = validateLatestJson(live);
  if (!lv.ok) throw new Error(`the live latest.json is invalid: ${lv.errors.join("; ")}`);
  if (live.version !== expected.version) throw new Error(`live version ${live.version} != ${expected.version}`);
  if (live.sha256 !== expected.sha256) throw new Error("live manifest sha256 does not match the published one");
  if (live.zipUrl !== env.RIOS_DROPBOX_ZIP_URL.trim()) {
    throw new Error("live feed zipUrl does not match the configured stable zip link (stale feed?)");
  }

  const liveZip = await fetchBuffer(live.zipUrl, "the published zip");
  if (looksLikeHtml(liveZip)) throw new Error("the zip URL returned a web page, not a zip (it must be a dl=1 link)");
  const liveSha = sha256Buffer(liveZip);
  if (liveSha !== expected.sha256) {
    throw new Error(`published zip sha256 mismatch (expected ${expected.sha256.slice(0, 12)}…, got ${liveSha.slice(0, 12)}…)`);
  }
}

// ---- main ----------------------------------------------------------------
async function main() {
  say(`\n${C.b}${APP_NAME} — publish student release${C.reset}`);
  if (args.dryRun) say(`${C.y}(dry run — building + verifying, uploading nothing)${C.reset}`);

  // One-time setup: resolve stable (no-`st=`) share links for the configured
  // paths and print them as the two env lines to save. Uploads nothing.
  if (args.printLinks) {
    requireVars(["RIOS_DROPBOX_ZIP_PATH", "RIOS_DROPBOX_MANIFEST_PATH"]);
    const token = await dropboxAccessToken();
    step("Resolving stable share links (no st= token)");
    const zipUrl = await resolveSharedLink(token, env.RIOS_DROPBOX_ZIP_PATH.trim(), "dl");
    const feedUrl = await resolveSharedLink(token, env.RIOS_DROPBOX_MANIFEST_PATH.trim(), "raw");
    say(`\n  Save these (e.g. in .env.release.local), and give the feed URL to pilots:\n`);
    say(`  RIOS_DROPBOX_ZIP_URL=${zipUrl}`);
    say(`  RIOS_UPDATE_FEED_URL=${feedUrl}\n`);
    return;
  }

  // Config the verify step always needs.
  requireVars(["RIOS_DROPBOX_ZIP_URL", "RIOS_UPDATE_FEED_URL"]);
  if (!args.dryRun) requireVars(["RIOS_DROPBOX_ZIP_PATH", "RIOS_DROPBOX_MANIFEST_PATH"]);

  if (!args.skipBuild) runBuild();
  assertNoLeaks(LATEST_ZIP);
  regenerateManifest(env.RIOS_DROPBOX_ZIP_URL.trim());

  const localSha = await sha256File(LATEST_ZIP);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const v = validateLatestJson(manifest);
  if (!v.ok) die(`generated latest.json is invalid:\n   ${v.errors.join("\n   ")}`);
  if (manifest.sha256 !== localSha) {
    die(`generated latest.json sha256 does not match the built zip — refusing to publish.`);
  }
  if (/REPLACE-WITH-DROPBOX/i.test(manifest.zipUrl || "")) {
    die(`latest.json still has a placeholder zipUrl. Set RIOS_DROPBOX_ZIP_URL to the real Dropbox link.`);
  }
  ok(`built ${manifest.version} (sha ${localSha.slice(0, 12)}…)`);

  if (args.dryRun) {
    step("Dry run complete");
    say(`  Would upload:`);
    say(`    ${LATEST_ZIP}\n      → ${env.RIOS_DROPBOX_ZIP_PATH || "(set RIOS_DROPBOX_ZIP_PATH)"}`);
    say(`    ${MANIFEST}\n      → ${env.RIOS_DROPBOX_MANIFEST_PATH || "(set RIOS_DROPBOX_MANIFEST_PATH)"}`);
    say(`  Feed URL: ${env.RIOS_UPDATE_FEED_URL}\n`);
    return;
  }

  const token = await dropboxAccessToken();

  // Upload the ZIP first, the MANIFEST last. The run fails loudly on any upload
  // error, so a death between the two leaves the feed still advertising the OLD
  // version (pilots undisturbed); and even mid-window, the updater's own sha256
  // check refuses any zip that doesn't match the manifest, so no pilot ever
  // installs a mismatched build. Re-running publish makes it consistent.
  step("Uploading to Dropbox (overwrite in place)");
  await dropboxUploadOverwrite(token, env.RIOS_DROPBOX_ZIP_PATH.trim(), readFileSync(LATEST_ZIP));
  ok(`zip → ${env.RIOS_DROPBOX_ZIP_PATH.trim()}`);
  await dropboxUploadOverwrite(token, env.RIOS_DROPBOX_MANIFEST_PATH.trim(), readFileSync(MANIFEST));
  ok(`latest.json → ${env.RIOS_DROPBOX_MANIFEST_PATH.trim()}`);

  // ---- verify the LIVE feed end to end (with a few retries for CDN lag) ----
  step("Verifying the live feed");
  const retries = Math.max(1, Number(env.RIOS_PUBLISH_VERIFY_RETRIES || 5));
  const delayMs = env.RIOS_PUBLISH_VERIFY_DELAY_MS !== undefined ? Number(env.RIOS_PUBLISH_VERIFY_DELAY_MS) : 3000;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await verifyLiveFeed(manifest);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        say(`  ${C.d}not live yet (${e.message}); retrying ${attempt}/${retries - 1}…${C.reset}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  if (lastErr) {
    die(`the published files did not verify live after ${retries} attempt(s): ${lastErr.message}`);
  }
  ok(`live feed + zip verified for ${manifest.version}`);

  step("Published");
  say(`\n  ${C.g}${C.b}${manifest.version} is live for pilots.${C.reset}`);
  say(`  Update feed (RIOS_UPDATE_FEED_URL):\n    ${env.RIOS_UPDATE_FEED_URL.trim()}\n`);
}

main().catch((e) => die(e?.message || String(e)));
