import test from "node:test";
import assert from "node:assert/strict";
import { selectClassifyPromptPrefix } from "../apps/runner/dist/services/ai.js";

test("selectClassifyPromptPrefix for LINKEDIN returns the LinkedIn-shaped prefix", () => {
  const prefix = selectClassifyPromptPrefix("LINKEDIN");
  assert.match(prefix, /Classify this LinkedIn thread/);
  assert.match(prefix, /sponsored InMails/);
  assert.match(prefix, /lead-gen scripts/);
});

test("selectClassifyPromptPrefix for casual platforms returns the messaging-app prefix", () => {
  const prefix = selectClassifyPromptPrefix("INSTAGRAM");
  assert.match(prefix, /messaging-app thread/);
  assert.match(prefix, /promotional broadcasts/);
  assert.match(prefix, /Vodafone/);
});

test("selectClassifyPromptPrefix for TIKTOK returns the casual prefix", () => {
  const prefix = selectClassifyPromptPrefix("TIKTOK");
  assert.match(prefix, /messaging-app thread/);
});

test("selectClassifyPromptPrefix for WHATSAPP returns the casual prefix", () => {
  const prefix = selectClassifyPromptPrefix("WHATSAPP");
  assert.match(prefix, /messaging-app thread/);
});

test("both classify prefixes return the same JSON output schema", () => {
  const formal = selectClassifyPromptPrefix("LINKEDIN");
  const casual = selectClassifyPromptPrefix("INSTAGRAM");
  // Same enum keeps Thread.category storage and the dashboard category
  // filter working unchanged across tiers.
  assert.match(formal, /Return strict JSON: \{ "category": "outreach" \| "genuine" \}/);
  assert.match(casual, /Return strict JSON: \{ "category": "outreach" \| "genuine" \}/);
});

test("formal and casual classify prefixes are distinct", () => {
  assert.notEqual(selectClassifyPromptPrefix("LINKEDIN"), selectClassifyPromptPrefix("INSTAGRAM"));
});
