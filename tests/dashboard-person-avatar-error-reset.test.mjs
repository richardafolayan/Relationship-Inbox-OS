import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// P3-PL3: PersonAvatar keeps a single `errored` flag set by the <img> onError
// handler and never cleared. The component is rendered inside thread-row lists
// keyed by a stable row.id and polled in place every ~10s; the runner
// re-derives personAvatarUrl fresh from person.avatarUrl on each fetch, and
// LinkedIn avatar URLs are signed and rotate. So a still-mounted row can
// receive a different, valid avatarUrl over time, but a stale errored=true keeps
// showImage=false and the new image is never attempted - defeating the file's
// own documented "next scan refreshes the row" recovery.
//
// The fix resets `errored` when avatarUrl changes, via the pure decision helper
// shouldResetAvatarError. The component is not unit-mountable here (the repo has
// react-dom but no react-test-renderer / @testing-library), so the component
// half is a static-source regression in the same idiom as
// dashboard-voice-transcript-prop-sync and dashboard-profile-drawer-state-race:
// the assertions fail if the reset effect (or its imports) is removed.

// avatar-error-reset.ts is framework-free, so the tsx loader resolves the .ts
// import directly (matches the dashboard-favourites / drawer-request-guard
// pattern).
const { shouldResetAvatarError } = await import(
  "../apps/dashboard/lib/avatar-error-reset.ts"
);

const SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../apps/dashboard/components/common/person-avatar.tsx",
      import.meta.url
    )
  ),
  "utf8"
);

test("shouldResetAvatarError resets only when the avatar URL value changes", () => {
  // A new, different URL (the rotated-signed-URL case) must reset the error so
  // the new image is attempted.
  assert.equal(
    shouldResetAvatarError("https://a.example/old.jpg", "https://a.example/new.jpg"),
    true,
    "a changed avatarUrl must re-arm the image attempt"
  );
  // Same URL must NOT reset, so a genuinely broken URL keeps the initials tile
  // instead of thrashing onError every poll.
  assert.equal(
    shouldResetAvatarError("https://a.example/x.jpg", "https://a.example/x.jpg"),
    false,
    "an unchanged avatarUrl must not reset the error state"
  );
  // null/undefined transitions.
  assert.equal(shouldResetAvatarError(null, null), false);
  assert.equal(shouldResetAvatarError(undefined, undefined), false);
  assert.equal(
    shouldResetAvatarError(null, "https://a.example/x.jpg"),
    true,
    "going from no URL to a real URL must allow an image attempt"
  );
  assert.equal(
    shouldResetAvatarError("https://a.example/x.jpg", null),
    true,
    "clearing the URL changes the tracked value"
  );
});

test("person-avatar.tsx imports useEffect, useRef and the reset helper", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\buseEffect\b[^}]*\buseRef\b[^}]*\}\s*from\s*[\"']react[\"']/,
    "must import useEffect and useRef from react"
  );
  assert.match(
    SRC,
    /import\s*\{\s*shouldResetAvatarError\s*\}\s*from\s*[\"']@\/lib\/avatar-error-reset[\"']/,
    "must import shouldResetAvatarError from the lib helper"
  );
});

test("PersonAvatar resets the errored flag when avatarUrl changes", () => {
  const start = SRC.indexOf("export function PersonAvatar");
  assert.ok(start !== -1, "PersonAvatar export should exist");
  const body = SRC.slice(start);

  // Tracks the previously-seen URL so the reset fires exactly on a value change.
  assert.match(
    body,
    /const lastUrlRef = useRef\(avatarUrl\)/,
    "PersonAvatar must track the last avatarUrl in a ref"
  );

  // A useEffect keyed on avatarUrl that, when the helper says the URL changed,
  // advances the ref and clears the error so the new image is attempted.
  const effect = body.match(
    /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?shouldResetAvatarError\(lastUrlRef\.current,\s*avatarUrl\)[\s\S]*?lastUrlRef\.current\s*=\s*avatarUrl[\s\S]*?setErrored\(false\)[\s\S]*?\}\s*,\s*\[\s*avatarUrl\s*\]\s*\)/
  );
  assert.ok(
    effect,
    "PersonAvatar must reset errored via useEffect(() => { if (shouldResetAvatarError(lastUrlRef.current, avatarUrl)) { lastUrlRef.current = avatarUrl; setErrored(false); } }, [avatarUrl])"
  );
});
