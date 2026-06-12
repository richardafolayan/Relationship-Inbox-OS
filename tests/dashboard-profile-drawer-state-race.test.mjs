import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Q6: late "Ask the AI" / friendship-summary responses must not land after the
// Profile drawer is closed (or switched to another person) and resurface on the
// next open. The drawer does NOT remount across open/close cycles, so its state
// survives between opens; the async handlers must gate their writeback on a
// per-open-session token. This mirrors the thread-page state-race guards test.

// drawer-request-guard.ts is framework-free, so the tsx loader resolves the .ts
// import directly (matches the dashboard-favourites.test.mjs pattern).
const { isCurrentDrawerRequest } = await import(
  "../apps/dashboard/lib/drawer-request-guard.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "common", "profile-drawer.tsx"),
  "utf8"
);

test("isCurrentDrawerRequest applies a writeback only when the open-session token is unchanged", () => {
  assert.equal(isCurrentDrawerRequest(3, 3), true);
  assert.equal(isCurrentDrawerRequest(3, 4), false, "a newer open session must discard the stale result");
  assert.equal(isCurrentDrawerRequest(0, 0), true);
});

test("the drawer declares a per-open-session request token ref", () => {
  assert.match(
    SRC,
    /const drawerRequestTokenRef = useRef\(0\)/,
    "drawerRequestTokenRef must be declared as a useRef counter"
  );
});

test("the open/fetch effect advances the token and clears the AI output fields", () => {
  // Scope to the open/fetch effect: from its `if (!open || !personId) return;`
  // guard up to the apiGet call that loads the person detail.
  const effectStart = SRC.indexOf("if (!open || !personId) return;");
  assert.ok(effectStart >= 0, "open/fetch effect guard not found");
  const effectBlock = SRC.slice(effectStart, SRC.indexOf("apiGet<PersonDetailResponse>", effectStart));
  assert.match(effectBlock, /drawerRequestTokenRef\.current \+= 1/, "open effect must advance the request token");
  assert.match(effectBlock, /setAskAnswer\(null\)/, "open effect must clear askAnswer");
  assert.match(effectBlock, /setFriendshipSummary\(null\)/, "open effect must clear friendshipSummary");
});

test("askAboutPerson snapshots the token before the await and guards setAskAnswer", () => {
  const askBlock = SRC.slice(SRC.indexOf("const askAboutPerson"), SRC.indexOf("const generateFriendshipSummary"));
  assert.match(askBlock, /const startToken = drawerRequestTokenRef\.current;/, "askAboutPerson must snapshot the token before the await");
  assert.match(
    askBlock,
    /if \(!isCurrentDrawerRequest\(startToken, drawerRequestTokenRef\.current\)\) return;\s*\n\s*setAskAnswer\(result\.answer\)/,
    "setAskAnswer must be gated by the current-request check"
  );
});

test("generateFriendshipSummary snapshots the token before the await and guards setFriendshipSummary", () => {
  const fsBlock = SRC.slice(SRC.indexOf("const generateFriendshipSummary"), SRC.indexOf("const rescan"));
  assert.match(fsBlock, /const startToken = drawerRequestTokenRef\.current;/, "generateFriendshipSummary must snapshot the token before the await");
  assert.match(
    fsBlock,
    /if \(!isCurrentDrawerRequest\(startToken, drawerRequestTokenRef\.current\)\) return;\s*\n\s*setFriendshipSummary\(result\)/,
    "setFriendshipSummary must be gated by the current-request check"
  );
});
