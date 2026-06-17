import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODAL = readFileSync(
  join(ROOT, "apps/dashboard/components/common/pilot-feedback-modal.tsx"),
  "utf8"
);

test("pilot feedback modal content scrolls inside the capped dialog", () => {
  assert.match(
    MODAL,
    /className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-\[14px\]"/,
    "the feedback modal header must not shrink into the scroll area"
  );

  const scrollPanes = MODAL.match(
    /className="min-h-0 flex-1 overflow-y-auto px-5 py-4"/g
  );

  assert.equal(
    scrollPanes?.length,
    2,
    "both feedback modal views need shrinkable scroll panes so tall screenshot lists keep Submit reachable"
  );
});
