import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the app shell uses the dynamic phone viewport and one safe-area dock owner", () => {
  const globals = read("apps/dashboard/app/globals.css");
  const shell = read("apps/dashboard/components/layout/app-shell.tsx");
  const dock = read("apps/dashboard/components/layout/mobile-dock.tsx");
  const canvas = read("apps/dashboard/components/common/canvas.tsx");

  assert.match(globals, /height: var\(--app-vv-height, 100%\)/);
  assert.match(shell, /installAppVisualViewport/);
  assert.match(shell, /grid h-app-screen[^\"]*overflow-hidden/);
  assert.match(dock, /pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.match(dock, /relative[^\"]*shrink-0/);
  assert.match(canvas, /pb-10/);
  assert.doesNotMatch(canvas, /safe-area-inset-bottom/);
});

test("phone list pages keep controls reachable without crushing row content", () => {
  const inbox = read("apps/dashboard/app/inbox/page.tsx");
  const today = read("apps/dashboard/app/today/page.tsx");
  const archived = read("apps/dashboard/app/archived/page.tsx");
  const people = read("apps/dashboard/app/people/page.tsx");
  const atRisk = read("apps/dashboard/app/at-risk/page.tsx");
  const settings = read("apps/dashboard/app/settings/page.tsx");
  const logs = read("apps/dashboard/app/logs/page.tsx");

  assert.match(inbox, /data-testid="inbox-controls"/);
  assert.match(inbox, /data-testid="inbox-list-scroller"/);
  assert.match(today, /data-testid="today-up-next"/);
  assert.match(archived, /data-testid="archived-list-scroller"/);
  assert.match(people, /grid-cols-\[32px_minmax\(0,1fr\)\]/);
  assert.match(atRisk, /grid grid-cols-3 gap-2/);
  assert.match(atRisk, /hidden px-\[14px\].*sm:inline-flex/);
  assert.match(settings, /<nav aria-label="Settings sections" className="md:hidden">/);
  assert.match(logs, /sm:grid-cols-\[80px_1fr_auto\]/);
});

test("thread AI and rich interactions use dedicated phone surfaces", () => {
  const thread = read("apps/dashboard/app/thread/[id]/page.tsx");
  const poll = read("apps/dashboard/components/thread/whatsapp-poll.tsx");
  const profile = read("apps/dashboard/components/common/profile-drawer.tsx");
  const receipts = read("apps/dashboard/components/common/receipts-drawer.tsx");

  assert.match(thread, /"fixed inset-0 w-full"/);
  assert.match(thread, /sm:inset-y-0 sm:left-auto sm:right-0 sm:w-\[min\(92vw,380px\)\]/);
  assert.match(thread, /pb-\[calc\(24px\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(poll, /min-h-\[44px\]/);
  assert.match(poll, /max-w-\[min\(86vw,340px\)\]/);
  assert.match(profile, /absolute inset-0 flex h-full w-full/);
  assert.match(receipts, /absolute inset-0 flex h-full w-full/);
});
