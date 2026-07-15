import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const THREAD_PAGE = readFileSync(join(ROOT, "apps/dashboard/app/thread/[id]/page.tsx"), "utf8");
const RUNNER_INDEX = readFileSync(join(ROOT, "apps/runner/src/index.ts"), "utf8");

test("WhatsApp composer exposes rich text, poll and media send controls", () => {
  assert.match(THREAD_PAGE, /thread\.platform === "WHATSAPP"/);
  assert.match(THREAD_PAGE, /wrapComposerSelection\("\*"\)/);
  assert.match(THREAD_PAGE, /wrapComposerSelection\("_"\)/);
  assert.match(THREAD_PAGE, /wrapComposerSelection\("~"\)/);
  assert.match(THREAD_PAGE, /wrapComposerSelection\("```", "```", "code"\)/);
  assert.match(THREAD_PAGE, /prefixComposerLines\(\(\) => "- "\)/);
  assert.match(THREAD_PAGE, /prefixComposerLines\(\(index\) => `\$\{index \+ 1\}\. `\)/);
  assert.match(THREAD_PAGE, /prefixComposerLines\(\(\) => "> "\)/);
  assert.match(THREAD_PAGE, /sendWhatsAppPoll/);
  assert.match(THREAD_PAGE, /image\/\*,video\/\*,audio\/\*,application\/pdf,\.gif/);
  assert.match(THREAD_PAGE, /thread\.platform === "IMESSAGE"[\s\S]*?thread\.platform === "WHATSAPP"/);
});

test("runner exposes a dedicated WhatsApp poll send route", () => {
  assert.match(RUNNER_INDEX, /\/control\/thread\/:threadId\/send-poll/);
  assert.match(RUNNER_INDEX, /adapter\.sendPoll/);
  assert.match(RUNNER_INDEX, /rawJson = receipt\.raw \? JSON\.stringify\(receipt\.raw\) : null/);
  assert.match(RUNNER_INDEX, /attachmentsJson/);
});
