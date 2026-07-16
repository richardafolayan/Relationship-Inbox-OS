import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("settings and setup only render platforms returned by the runner", async () => {
  const settings = await readFile(
    new URL("../apps/dashboard/app/settings/page.tsx", import.meta.url),
    "utf8"
  );
  const setup = await readFile(
    new URL("../apps/dashboard/components/common/SetupWizard.tsx", import.meta.url),
    "utf8"
  );

  assert.match(settings, /imessageRow \? \(/);
  assert.match(settings, /googleMessagesRow \? \(/);
  assert.match(settings, /whatsappRow \? \(/);
  assert.match(settings, /available\.has\("IMESSAGE"\)/);
  assert.match(settings, /available\.has\("GOOGLE_MESSAGES"\)/);
  assert.match(setup, /filter\(\(\[platform\]\) => available\.includes\(platform\)\)/);
});
