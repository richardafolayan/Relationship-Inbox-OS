import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyOperatorProfile,
  shouldSeedOperatorProfile,
  normaliseSeedProfile,
  PLACEHOLDER_DISPLAY_NAMES
} from "../apps/runner/dist/services/operator-profile-seed.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EMPTY = {
  displayName: "",
  about: "",
  interests: "",
  commonPhrases: "",
  avoidedPhrases: "",
  preferredStyle: "",
  aiHelpLevel: "writing_support",
  setupCompletedAt: ""
};

test("an empty operator profile classifies as empty and is seedable", () => {
  // A fresh / new user starts here — the seeder may populate it.
  assert.equal(classifyOperatorProfile(EMPTY), "empty");
  assert.equal(shouldSeedOperatorProfile(EMPTY), true);
});

test("a placeholder or test profile classifies as placeholder and is seedable", () => {
  const sam = {
    ...EMPTY,
    displayName: "Sam",
    about: "British peer-to-peer test profile.",
    aiHelpLevel: "full_drafts"
  };
  assert.equal(classifyOperatorProfile(sam), "placeholder");
  assert.equal(shouldSeedOperatorProfile(sam), true);
  assert.ok(PLACEHOLDER_DISPLAY_NAMES.includes("sam"));

  // A non-placeholder name still reads as a placeholder when the
  // description itself says it is a test.
  const named = { ...EMPTY, displayName: "Jordan", about: "just testing things" };
  assert.equal(classifyOperatorProfile(named), "placeholder");
});

test("a real, non-empty profile is preserved and not seeded", () => {
  const real = {
    ...EMPTY,
    displayName: "Priya",
    about: "I write warmly and keep replies short.",
    preferredStyle: "warm"
  };
  assert.equal(classifyOperatorProfile(real), "real");
  assert.equal(shouldSeedOperatorProfile(real), false);
  // ...unless the caller explicitly forces an overwrite.
  assert.equal(shouldSeedOperatorProfile(real, { force: true }), true);
});

test("normaliseSeedProfile fills missing fields and stamps the setup time", () => {
  const profile = normaliseSeedProfile(
    { displayName: "Test User", about: "hi", preferredStyle: "bogus", aiHelpLevel: "nope" },
    () => "2026-05-21T00:00:00.000Z"
  );
  assert.equal(profile.displayName, "Test User");
  assert.equal(profile.interests, "");
  assert.equal(profile.commonPhrases, "");
  assert.equal(profile.preferredStyle, ""); // invalid enum falls back to ""
  assert.equal(profile.aiHelpLevel, "writing_support"); // invalid enum falls back to default
  assert.equal(profile.setupCompletedAt, "2026-05-21T00:00:00.000Z");
});

test("normaliseSeedProfile keeps a valid style and an explicit setup time", () => {
  const profile = normaliseSeedProfile({
    displayName: "X",
    about: "y",
    preferredStyle: "casual",
    aiHelpLevel: "memory_only",
    setupCompletedAt: "2024-01-01T00:00:00.000Z"
  });
  assert.equal(profile.preferredStyle, "casual");
  assert.equal(profile.aiHelpLevel, "memory_only");
  assert.equal(profile.setupCompletedAt, "2024-01-01T00:00:00.000Z");
});

test("the three AI help levels are unchanged and survive a seed", () => {
  for (const level of ["memory_only", "writing_support", "full_drafts"]) {
    assert.equal(normaliseSeedProfile({ aiHelpLevel: level }).aiHelpLevel, level);
  }
});

test("the operator-profile defaults and seed mechanism hardcode no personal name", () => {
  // Personal voice data lives only in a gitignored local seed file and the
  // local DB row — never in committed source, so new users start blank.
  const files = [
    "apps/runner/src/services/operator-profile-seed.ts",
    "apps/runner/src/scripts/seed-operator-profile.ts",
    "apps/runner/operator-profile.seed.example.json",
    "apps/runner/src/services/settings.ts",
    "apps/dashboard/components/settings/UserVoiceProfile.tsx"
  ];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(text, /\bRichard\b/i, `${rel} must not hardcode a personal name`);
  }
});
