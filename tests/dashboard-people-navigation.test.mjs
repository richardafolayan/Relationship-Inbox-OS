import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildPersonInboxHref } = await import(
  "../apps/dashboard/lib/people-navigation.ts"
);

const peopleSource = readFileSync(
  new URL("../apps/dashboard/app/people/page.tsx", import.meta.url),
  "utf8"
);

test("People opens the Inbox using its supported q deep-link contract", () => {
  assert.equal(buildPersonInboxHref("  Ana María & Jo  "), "/inbox?q=Ana%20Mar%C3%ADa%20%26%20Jo");
  assert.match(peopleSource, /router\.push\(buildPersonInboxHref\(person\.name\)\)/);
  assert.doesNotMatch(peopleSource, /\/inbox\?person=/);
});

test("conversation ideas are calm reference cards rather than dead buttons", () => {
  assert.match(peopleSource, /<CtxBlock label="Conversation ideas">/);
  assert.match(peopleSource, /<article/);
  assert.doesNotMatch(peopleSource, /use ↵/);
});

test("a failed People request is not presented as a genuine empty account", () => {
  assert.match(peopleSource, /error && people\.length === 0/);
  assert.match(peopleSource, />\s*Try again\s*</);
});
