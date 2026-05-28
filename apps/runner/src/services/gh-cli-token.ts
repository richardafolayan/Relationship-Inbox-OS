// Resolves a GitHub token from the local `gh` CLI auth (`gh auth token`)
// so the runner can do GitHub work without forcing the operator to copy
// a PAT into .env. Used by the pilot-feedback screenshot-attach flow
// (#423 follow-up) when GITHUB_TOKEN / GH_TOKEN are not set in env.
//
// Caches the resolved token in-process for the runner's lifetime — `gh
// auth token` is fast (~30ms) but there's no need to spawn it on every
// pilot-feedback POST. The cache is dropped on runner restart, so token
// rotation via `gh auth refresh` picks up after a restart.
//
// Returns null on:
//   - gh binary missing (CI / production deploys without gh installed)
//   - gh not authenticated (no keyring entry, no env override)
//   - any spawn / parse error
//
// Caller falls back gracefully (skips the screenshot-attach step and
// logs a warning) when null is returned, so this resolver is purely
// additive — it never breaks the existing webhook flow.

import { spawn } from "node:child_process";

let cached: string | null | undefined = undefined;

function runGhAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      void err;
      if (code !== 0) {
        resolve(null);
        return;
      }
      const token = out.trim();
      // gh tokens are 40+ chars starting with gho_ / ghp_ / etc. Anything
      // shorter is almost certainly garbage; bail rather than passing a
      // malformed value to the GitHub API.
      if (token.length < 30) {
        resolve(null);
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Returns a GitHub token, preferring the explicit `envToken` arg
 * (typically GITHUB_TOKEN / GH_TOKEN from runner config). When that's
 * unset, falls back to `gh auth token` from the local gh CLI. Cached
 * for the runner's lifetime; restart picks up rotated tokens.
 *
 * Test-only: pass `forceRefresh: true` to bypass the cache.
 */
export async function resolveGitHubToken(opts: {
  envToken?: string;
  forceRefresh?: boolean;
  /** Test override — defaults to runGhAuthToken. */
  spawnGhAuthToken?: () => Promise<string | null>;
}): Promise<string | null> {
  if (opts.envToken && opts.envToken.length > 0) {
    return opts.envToken;
  }
  if (!opts.forceRefresh && cached !== undefined) {
    return cached;
  }
  const fn = opts.spawnGhAuthToken ?? runGhAuthToken;
  const token = await fn();
  cached = token;
  return token;
}

/** Test-only: clear the in-process cache. */
export function _resetGhTokenCacheForTests(): void {
  cached = undefined;
}
