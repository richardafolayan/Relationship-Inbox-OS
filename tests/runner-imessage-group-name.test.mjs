import test from "node:test";
import assert from "node:assert/strict";
import {
  groupStubFields,
  shouldRefreshGroupDisplayName
} from "../apps/runner/dist/platforms/imessage-group-name.js";

// #427: an iMessage group renamed on this device must surface its new name
// in the inbox. v1 stores the group name as the synthetic Person's
// displayName, so the scanner refreshes that row from chat.db under a
// profileUrl-style no-clobber rule. These cover the two pure pieces:
// deriving the stub fields from a chat.db row, and the refresh decision.

test("groupStubFields: 1:1 chat carries no group name", () => {
  assert.deepEqual(groupStubFields({ isGroup: false, userSetName: null }), {
    isGroup: false,
    groupName: undefined
  });
});

test("groupStubFields: a userSetName on a 1:1 is ignored (not a group)", () => {
  // Defensive — chat.db shouldn't set this for a 1:1, but isGroup gates it.
  assert.deepEqual(groupStubFields({ isGroup: false, userSetName: "Mum" }), {
    isGroup: false,
    groupName: undefined
  });
});

test("groupStubFields: named group surfaces the operator-set chat name", () => {
  assert.deepEqual(
    groupStubFields({ isGroup: true, userSetName: "Trip 2026" }),
    { isGroup: true, groupName: "Trip 2026" }
  );
});

test("groupStubFields: group named on another device has no local name", () => {
  // chat.db's display_name is NULL when the name was set on another device;
  // there's nothing to apply, so groupName stays undefined.
  assert.deepEqual(groupStubFields({ isGroup: true, userSetName: null }), {
    isGroup: true,
    groupName: undefined
  });
});

test("shouldRefreshGroupDisplayName: refreshes a stale auto name (the fix)", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: "Trip 2026",
      currentDisplayName: "Trip Planning",
      currentSource: "auto"
    }),
    true
  );
});

test("shouldRefreshGroupDisplayName: refreshes when source is unset (legacy row)", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: "Trip 2026",
      currentDisplayName: "Trip Planning",
      currentSource: null
    }),
    true
  );
});

test("shouldRefreshGroupDisplayName: never clobbers a manual name", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: "Trip 2026",
      currentDisplayName: "My Squad",
      currentSource: "manual"
    }),
    false
  );
});

test("shouldRefreshGroupDisplayName: no-op when the name already matches", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: "Trip 2026",
      currentDisplayName: "Trip 2026",
      currentSource: "auto"
    }),
    false
  );
});

test("shouldRefreshGroupDisplayName: ignores non-group threads", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: false,
      groupName: "Trip 2026",
      currentDisplayName: "+447506440284",
      currentSource: "auto"
    }),
    false
  );
});

test("shouldRefreshGroupDisplayName: no name to apply (named on another device)", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: undefined,
      currentDisplayName: "Alice, Bob, Carol",
      currentSource: "auto"
    }),
    false
  );
});

test("shouldRefreshGroupDisplayName: empty-string name never overwrites", () => {
  assert.equal(
    shouldRefreshGroupDisplayName({
      isGroup: true,
      groupName: "",
      currentDisplayName: "Alice, Bob, Carol",
      currentSource: "auto"
    }),
    false
  );
});
