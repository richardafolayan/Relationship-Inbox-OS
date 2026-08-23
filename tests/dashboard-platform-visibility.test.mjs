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
  assert.match(settings, /instagramRow \? \(/);
  assert.match(settings, /whatsappRow \? \(/);
  assert.match(settings, /available\.has\("IMESSAGE"\)/);
  assert.match(settings, /available\.has\("GOOGLE_MESSAGES"\)/);
  assert.match(settings, /available\.has\("INSTAGRAM"\)/);
  assert.match(setup, /\["INSTAGRAM", "Instagram"/);
  assert.match(setup, /selected\.includes\("INSTAGRAM"\)/);
  assert.match(setup, /filter\(\(\[platform\]\) => available\.includes\(platform\)\)/);
});

test("Instagram is available in active and archived platform filters", async () => {
  const inbox = await readFile(
    new URL("../apps/dashboard/app/inbox/page.tsx", import.meta.url),
    "utf8"
  );
  const archived = await readFile(
    new URL("../apps/dashboard/app/archived/page.tsx", import.meta.url),
    "utf8"
  );

  assert.match(inbox, /\{ key: "INSTAGRAM", label: "Instagram" \}/);
  assert.match(archived, /\{ key: "INSTAGRAM", label: "Instagram" \}/);
});
