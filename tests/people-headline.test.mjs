import test from "node:test";
import assert from "node:assert/strict";
import { personHeadlineLine } from "../apps/dashboard/lib/people-headline.ts";

test("prefers an explicit headline", () => {
  assert.equal(
    personHeadlineLine({
      headline: "Founder, building in public",
      currentRole: "CEO",
      currentCompany: "Acme"
    }),
    "Founder, building in public"
  );
});

test("joins role and company when there is no headline", () => {
  assert.equal(
    personHeadlineLine({ headline: null, currentRole: "Designer", currentCompany: "Acme" }),
    "Designer at Acme"
  );
});

test("uses role alone when company is missing", () => {
  assert.equal(
    personHeadlineLine({ currentRole: "Designer", currentCompany: null }),
    "Designer"
  );
});

test("uses company alone when role is missing", () => {
  assert.equal(
    personHeadlineLine({ currentRole: null, currentCompany: "Acme" }),
    "Acme"
  );
});

test("falls back to 'no profile yet' when role and company are both missing (the bug)", () => {
  assert.equal(
    personHeadlineLine({ headline: null, currentRole: null, currentCompany: null }),
    "no profile yet"
  );
});

test("falls back to 'no profile yet' for an empty object", () => {
  assert.equal(personHeadlineLine({}), "no profile yet");
});

test("treats whitespace-only fields as empty", () => {
  assert.equal(
    personHeadlineLine({ headline: "   ", currentRole: "  ", currentCompany: "" }),
    "no profile yet"
  );
});
