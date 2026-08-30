import test from "node:test";
import assert from "node:assert/strict";

import { createIMessageSelectionLifecycle } from "../apps/runner/src/services/imessage-selection-lifecycle.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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

test("a newer opt-out prevents a delayed enable from starting private background work", async () => {
  const probe = deferred();
  const calls = [];
  const lifecycle = createIMessageSelectionLifecycle({
    probe: async () => {
      calls.push("probe:start");
      await probe.promise;
      calls.push("probe:end");
    },
    startBirthdaySync: () => { calls.push("birthday:start"); },
    stopBirthdaySync: () => { calls.push("birthday:stop"); },
    startNameSync: () => { calls.push("names:start"); },
    stopNameSync: () => { calls.push("names:stop"); },
    startWatcher: () => { calls.push("watcher:start"); },
    stopWatcher: () => { calls.push("watcher:stop"); }
  });

  const enabling = lifecycle.reconcile(true);
  await Promise.resolve();
  const disabling = lifecycle.reconcile(false);
  probe.resolve();
  await Promise.all([enabling, disabling]);

  assert.deepEqual(calls, ["probe:start", "probe:end"]);
  assert.equal(lifecycle.isActive(), false);
});
