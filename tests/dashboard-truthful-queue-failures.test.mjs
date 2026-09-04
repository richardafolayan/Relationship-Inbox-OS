import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runConfirmedTodayAction } from "../apps/dashboard/lib/today-action.ts";

const todaySource = readFileSync(
  new URL("../apps/dashboard/app/today/page.tsx", import.meta.url),
  "utf8"
);
const inboxSource = readFileSync(
  new URL("../apps/dashboard/app/inbox/page.tsx", import.meta.url),
  "utf8"
);

test("Today advances only through the confirmed action helper", () => {
  assert.match(todaySource, /runConfirmedTodayAction/);
  assert.doesNotMatch(
    todaySource,
    /runAction\(apiPost\(`\/runner\/control\/thread\/\$\{id\}\/(?:snooze|mark-done)`/
  );
});

test("a rejected Today action does not confirm queue progress", async () => {
  let confirmations = 0;
  let failure = "";

  const confirmed = await runConfirmedTodayAction({
    request: () => Promise.reject(new Error("runner unavailable")),
    onConfirmed: () => {
      confirmations += 1;
    },
    onFailure: (message) => {
      failure = message;
    }
  });

  assert.equal(confirmed, false);
  assert.equal(confirmations, 0);
  assert.equal(failure, "runner unavailable");
});

test("a successful Today action confirms queue progress once", async () => {
  let confirmations = 0;

  const confirmed = await runConfirmedTodayAction({
    request: () => Promise.resolve(),
    onConfirmed: () => {
      confirmations += 1;
    },
    onFailure: () => assert.fail("success must not report failure")
  });

  assert.equal(confirmed, true);
  assert.equal(confirmations, 1);
});

test("Inbox distinguishes a cold runner failure from a genuinely empty inbox", () => {
  assert.match(inboxSource, /data-testid="inbox-unavailable"/);
  assert.match(inboxSource, /setInboxUnavailable\(inbox === null\)/);
});

test("hidden Inbox row controls cannot intercept pointer taps", () => {
  assert.ok(
    (inboxSource.match(/pointer-events-none/g) ?? []).length >= 2,
    "both the hidden selection and favourite controls must ignore pointer taps"
  );
  assert.ok(
    (inboxSource.match(/group-hover:pointer-events-auto/g) ?? []).length >= 2,
    "both controls must regain pointer interaction when visibly revealed"
  );
});
