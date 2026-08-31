import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { buildPersonInboxHref } = await import(
  "../apps/dashboard/lib/people-navigation.ts"
);
const { inboxRowMatchesLookup, readInboxPersonIdParam } = await import(
  "../apps/dashboard/lib/inbox-query.ts"
);

const peopleSource = readFileSync(
  new URL("../apps/dashboard/app/people/page.tsx", import.meta.url),
  "utf8"
);
const inboxSource = readFileSync(
  new URL("../apps/dashboard/app/inbox/page.tsx", import.meta.url),
  "utf8"
);

test("People opens an exact person filter rather than a name search", () => {
  assert.equal(
    buildPersonInboxHref("person/ana & jo", "  Ana María & Jo  "),
    "/inbox?personId=person%2Fana%20%26%20jo&q=Ana%20Mar%C3%ADa%20%26%20Jo"
  );
  assert.match(
    peopleSource,
    /router\.push\(\s*buildPersonInboxHref\(person\.id, person\.name\)\s*\)/
  );
  assert.match(inboxSource, /readInboxPersonIdParam\(window\.location\.search\)/);
  assert.match(inboxSource, /inboxRowMatchesLookup\(row, \{ query: q, personId: personFilterId \}\)/);
});

test("exact person filtering rejects duplicate names and preview collisions", () => {
  const intended = {
    personId: "person-1",
    personName: "Alex Smith",
    preview: "See you tomorrow"
  };
  const duplicateName = {
    personId: "person-2",
    personName: "Alex Smith",
    preview: "Different person"
  };
  const previewCollision = {
    personId: "person-3",
    personName: "Jordan Lee",
    preview: "Alex Smith sent the notes"
  };

  assert.equal(inboxRowMatchesLookup(intended, { personId: "person-1", query: "Alex Smith" }), true);
  assert.equal(inboxRowMatchesLookup(duplicateName, { personId: "person-1", query: "Alex Smith" }), false);
  assert.equal(inboxRowMatchesLookup(previewCollision, { personId: "person-1", query: "Alex Smith" }), false);
});

test("text search remains available when no exact person filter is present", () => {
  const row = {
    personId: "person-3",
    personName: "Jordan Lee",
    preview: "Alex Smith sent the notes"
  };

  assert.equal(inboxRowMatchesLookup(row, { personId: "", query: "alex smith" }), true);
  assert.equal(readInboxPersonIdParam("?personId=person%2Fana%20%26%20jo"), "person/ana & jo");
  assert.equal(readInboxPersonIdParam("?q=Alex"), "");
});
