import test from "node:test";
import assert from "node:assert/strict";

const { isIMessageFullDiskAccessProblem, selectImessageFdaRecovery } = await import(
  "../apps/dashboard/lib/imessage-fda.ts"
);

function imessageRow(overrides = {}) {
  return {
    platform: "IMESSAGE",
    status: "NOT_CONNECTED",
    lastScanAt: null,
    connectedAt: "2026-07-13T09:00:00.000Z",
    lastError: "unable to open database file",
    enabled: true,
    profileDir: "",
    ...overrides
  };
}

test("detects the chat.db Full Disk Access denial", () => {
  assert.equal(isIMessageFullDiskAccessProblem(imessageRow()), true);
  assert.equal(
    isIMessageFullDiskAccessProblem(
      imessageRow({ lastError: "Cannot read the local Messages database. Open Full Disk Access." })
    ),
    true
  );
});

test("connected iMessage is never a Full Disk Access problem", () => {
  assert.equal(
    isIMessageFullDiskAccessProblem(imessageRow({ status: "CONNECTED", lastError: null })),
    false
  );
});

test("a better-sqlite3 ABI mismatch is not a Full Disk Access problem", () => {
  // "unable to open" but caused by a NODE_MODULE_VERSION mismatch, which
  // re-granting Full Disk Access can't fix.
  assert.equal(
    isIMessageFullDiskAccessProblem(
      imessageRow({
        lastError:
          "was compiled against a different Node.js version using NODE_MODULE_VERSION 115"
      })
    ),
    false
  );
});

test("non-iMessage platforms are ignored", () => {
  assert.equal(
    isIMessageFullDiskAccessProblem(
      imessageRow({ platform: "WHATSAPP", lastError: "unable to open database file" })
    ),
    false
  );
  assert.equal(isIMessageFullDiskAccessProblem(undefined), false);
  assert.equal(isIMessageFullDiskAccessProblem(null), false);
});

test("selectImessageFdaRecovery returns the row only when it was connected before", () => {
  const platforms = [
    { platform: "WHATSAPP", status: "CONNECTED", connectedAt: "x", lastError: null },
    imessageRow()
  ];
  const row = selectImessageFdaRecovery(platforms);
  assert.ok(row);
  assert.equal(row.platform, "IMESSAGE");
});

test("selectImessageFdaRecovery ignores a never-connected iMessage (first-run setup)", () => {
  // No connectedAt: the operator never granted access in the first place, so
  // this is Settings-guided setup, not an "access was reset" recovery.
  assert.equal(selectImessageFdaRecovery([imessageRow({ connectedAt: null })]), null);
});

test("selectImessageFdaRecovery returns null when iMessage is healthy or absent", () => {
  assert.equal(
    selectImessageFdaRecovery([imessageRow({ status: "CONNECTED", lastError: null })]),
    null
  );
  assert.equal(selectImessageFdaRecovery([{ platform: "LINKEDIN", status: "CONNECTED" }]), null);
  assert.equal(selectImessageFdaRecovery(null), null);
  assert.equal(selectImessageFdaRecovery(undefined), null);
});
