import test from "node:test";
import assert from "node:assert/strict";

import { createIMessageSelectionLifecycle } from "../apps/runner/src/services/imessage-selection-lifecycle.ts";

test("iMessage probing, Contacts work, and watching follow source selection exactly once", async () => {
  const calls = [];
  const lifecycle = createIMessageSelectionLifecycle({
    probe: async () => { calls.push("probe"); },
    startBirthdaySync: () => { calls.push("birthday:start"); },
    stopBirthdaySync: () => { calls.push("birthday:stop"); },
    startNameSync: () => { calls.push("names:start"); },
    stopNameSync: () => { calls.push("names:stop"); },
    startWatcher: () => { calls.push("watcher:start"); },
    stopWatcher: () => { calls.push("watcher:stop"); }
  });

  await lifecycle.reconcile(false);
  assert.deepEqual(calls, []);
  await lifecycle.reconcile(true);
  await lifecycle.reconcile(true);
  assert.deepEqual(calls, ["probe", "birthday:start", "names:start", "watcher:start"]);
  await lifecycle.reconcile(false);
  assert.deepEqual(calls.slice(-3), ["birthday:stop", "names:stop", "watcher:stop"]);
  await lifecycle.reconcile(true);
  assert.equal(calls.filter((call) => call === "probe").length, 2);
});
