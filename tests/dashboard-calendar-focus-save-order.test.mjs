import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(
    new URL(
      "../apps/dashboard/components/settings/CalendarFocusSection.tsx",
      import.meta.url
    )
  ),
  "utf8"
);

test("calendar settings serialize saves and read the latest value when each save starts", () => {
  assert.match(
    SRC,
    /const saveQueueRef = useRef<Promise<void>>\(Promise\.resolve\(\)\)/,
    "calendar settings must keep a single save queue"
  );
  assert.match(
    SRC,
    /saveQueueRef\.current\s*\.catch\(\(\) => undefined\)\s*\.then\(async \(\) => \{\s*await saveCalendarSync\(latest\.current\)/,
    "each queued save must read latest.current only after the previous save settles"
  );
  assert.match(
    SRC,
    /saveQueueRef\.current = pending\.catch\(\(\) => undefined\)/,
    "failed saves must be absorbed by the queue so later saves still run"
  );
});
