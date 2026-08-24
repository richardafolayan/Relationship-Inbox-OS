import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  platformSupportsScheduledSend
} from "../apps/dashboard/lib/platform-send-capabilities.ts";

test("Instagram does not advertise scheduled sends", () => {
  assert.equal(platformSupportsScheduledSend("INSTAGRAM"), false);
  assert.equal(platformSupportsScheduledSend("LINKEDIN"), true);
});

test("thread composer gates phone and desktop scheduling controls by platform capability", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /platformSupportsScheduledSend\(thread\.platform\)/);
  assert.match(source, /canScheduleSend\s*\?/);
});

test("phone composer hides its more-actions trigger when every action group is empty", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /const hasMobileComposerActions = mobileComposerGroups\.some\(\(group\) => group\.items\.length > 0\)/
  );
  assert.equal((source.match(/\{hasMobileComposerActions \? \(/g) ?? []).length, 2);
});

test("Instagram platform details direct checks through Scan now", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/app/platforms/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /row\.platform === "INSTAGRAM"/);
  assert.match(source, /Scan now checks Instagram and updates diagnostics\./);
});
