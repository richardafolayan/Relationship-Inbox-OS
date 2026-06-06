// Shared release-manifest helpers for the student-pilot release + updater.
//
// Pure and dependency-free so the release builder, the updater, and the test
// suite can all import the same validation and version logic. No network, no
// filesystem side effects beyond the explicit sha256File helper.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * The shape written to latest.json and read by the updater. Kept small on
 * purpose: a calm pilot updater, not a package manager.
 *
 *   {
 *     "version": "0.1.0",                       // semver of the release
 *     "build": "2026-06-06T00:00:00Z",          // ISO-8601 build time
 *     "commit": "abc1234",                       // git commit it was built from
 *     "zipUrl": "https://www.dropbox.com/...?dl=1",
 *     "sha256": "<64 hex>",                      // checksum of the zip
 *     "releaseNotes": ["...", "..."],
 *     "minimumInstallerVersion": "0.1.0"         // oldest installer that can apply it
 *   }
 */
export const LATEST_JSON_REQUIRED = [
  "version",
  "build",
  "commit",
  "zipUrl",
  "sha256",
  "releaseNotes",
  "minimumInstallerVersion"
];

const SEMVER_CORE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * Parse a semver-ish "MAJOR.MINOR.PATCH" string (an optional -prerelease or
 * +build suffix is tolerated). Returns null on anything unparseable.
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(SEMVER_CORE);
  if (!m) return null;
  const prerelease = /-(.+?)(?:\+|$)/.exec(value.trim());
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: prerelease ? prerelease[1] : "",
    raw: value.trim()
  };
}

/**
 * Compare two version strings. Returns -1 if a < b, 1 if a > b, 0 if equal.
 * Unparseable versions sort below parseable ones. A release with no
 * prerelease ranks above the same core with a prerelease (standard semver).
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  // Equal core. No prerelease > has prerelease.
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

/**
 * Validate a parsed latest.json object. Returns { ok, errors } so callers can
 * fail safely on malformed metadata rather than acting on half-trusted input.
 */
export function validateLatestJson(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["latest.json must be a JSON object"] };
  }
  for (const field of LATEST_JSON_REQUIRED) {
    if (!(field in obj)) errors.push(`missing required field: ${field}`);
  }

  if ("version" in obj && !parseVersion(obj.version)) {
    errors.push(`version is not a valid semver string: ${JSON.stringify(obj.version)}`);
  }
  if ("minimumInstallerVersion" in obj && !parseVersion(obj.minimumInstallerVersion)) {
    errors.push(
      `minimumInstallerVersion is not a valid semver string: ${JSON.stringify(obj.minimumInstallerVersion)}`
    );
  }
  if ("build" in obj && (typeof obj.build !== "string" || Number.isNaN(Date.parse(obj.build)))) {
    errors.push(`build is not a valid ISO-8601 timestamp: ${JSON.stringify(obj.build)}`);
  }
  if ("commit" in obj && (typeof obj.commit !== "string" || obj.commit.trim() === "")) {
    errors.push("commit must be a non-empty string");
  }
  if ("zipUrl" in obj && !isHttpUrl(obj.zipUrl)) {
    errors.push(`zipUrl must be an http(s) URL: ${JSON.stringify(obj.zipUrl)}`);
  }
  if ("sha256" in obj && (typeof obj.sha256 !== "string" || !SHA256_HEX.test(obj.sha256))) {
    errors.push("sha256 must be a 64-character hex string");
  }
  if ("releaseNotes" in obj) {
    if (!Array.isArray(obj.releaseNotes) || obj.releaseNotes.some((n) => typeof n !== "string")) {
      errors.push("releaseNotes must be an array of strings");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lowercase hex sha256 of a buffer or string. */
export function sha256Buffer(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Lowercase hex sha256 of a file, streamed so large zips don't load to RAM. */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Secret-bearing FILES that must never ship in a release zip, matched anywhere
 * in the tree. Anyone with the Dropbox link can download the zip, so a leak
 * here is a real exposure. `.env.example` is allowed (it carries no secrets)
 * and is excluded before these run.
 */
export const FORBIDDEN_RELEASE_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i, // .env, .env.local, .env.production (not .env.example)
  /\.sqlite(-wal|-shm|-journal)?$/i,
  /\.db$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i, // private keys / keystores / credentials
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)\b/i, // SSH private keys
  /(^|\/)[^/]*(service[-_]?account|client[_-]?secret|adminsdk|application_default_credentials)[^/]*\.json$/i, // cloud/service-account creds
  /(^|\/)\.npmrc$/i, // can carry an npm auth token
  /(^|\/)\.DS_Store$/
];

/**
 * Runtime / dependency directories that must not ship in a release zip.
 *  - node_modules / .git are forbidden at ANY depth (never legitimate source).
 *  - data / logs are forbidden only at the top (segment 0 or 1), because they
 *    are common SOURCE names deeper in the tree (e.g.
 *    apps/dashboard/app/logs/page.tsx) and must not be mistaken for runtime dirs.
 */
const FORBIDDEN_ANY_DEPTH_DIRS = new Set(["node_modules", ".git"]);
const FORBIDDEN_TOP_DIRS = new Set(["data", "logs"]);

/**
 * Return the subset of `entries` (relative paths) that are forbidden in a
 * release zip. `.env.example` is explicitly allowed.
 */
export function findForbiddenEntries(entries) {
  return entries.filter((raw) => {
    const entry = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
    if (/(^|\/)\.env\.example$/.test(entry)) return false;
    if (FORBIDDEN_RELEASE_PATTERNS.some((re) => re.test(entry))) return true;
    const segs = entry.split("/").filter(Boolean);
    if (segs.some((s) => FORBIDDEN_ANY_DEPTH_DIRS.has(s))) return true;
    if (segs.length >= 1 && FORBIDDEN_TOP_DIRS.has(segs[0])) return true;
    if (segs.length >= 2 && FORBIDDEN_TOP_DIRS.has(segs[1])) return true;
    return false;
  });
}
