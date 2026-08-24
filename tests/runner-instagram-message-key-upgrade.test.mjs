import test from "node:test";
import assert from "node:assert/strict";
import {
  applyInstagramMessageKeyUpgradePlan,
  InstagramMessageKeyUpgradeError,
  planInstagramMessageKeyUpgrades
} from "../apps/runner/dist/services/instagram-message-key-upgrade.js";

function currentMessage(overrides = {}) {
  return {
    platformMessageKey: "instagram:stable",
    platformMessageKeyMigration: {
      scheme: "instagram_occurrence_v1",
      candidateKey: "instagram:legacy-0"
    },
    direction: "IN",
    timestamp: "2026-08-20T10:00:00.000Z",
    text: "Hello",
    raw: {
      timestampSource: "source",
      contentKind: "text",
      messageIdentityVersion: "instagram_stable_v2"
    },
    attachments: [],
    ...overrides
  };
}

function existingRow(overrides = {}) {
  return {
    id: "message-legacy",
    threadId: "thread-1",
    platformMessageKey: "instagram:legacy-0",
    direction: "IN",
    timestamp: new Date("2026-08-20T10:00:00.000Z"),
    text: "Hello",
    rawJson: JSON.stringify({ timestampSource: "source", contentKind: "text" }),
    attachmentsJson: null,
    sentVia: null,
    audioTranscription: null,
    ...overrides
  };
}

function inMemoryDatabase(initialRows) {
  let rows = structuredClone(initialRows);
  return {
    rows: () => structuredClone(rows),
    async $transaction(callback) {
      const transactionRows = structuredClone(rows);
      const transaction = {
        message: {
          async findUnique(input) {
            const compound = input.where.threadId_platformMessageKey;
            const row = transactionRows.find(
              (candidate) =>
                candidate.threadId === compound.threadId &&
                candidate.platformMessageKey === compound.platformMessageKey
            );
            return row
              ? {
                  id: row.id,
                  platformMessageKey: row.platformMessageKey,
                  audioTranscription: row.audioTranscription
                }
              : null;
          },
          async update(input) {
            const row = transactionRows.find((candidate) => candidate.id === input.where.id);
            if (!row) throw new Error("message missing");
            if (
              input.data.platformMessageKey &&
              transactionRows.some(
                (candidate) =>
                  candidate.id !== row.id &&
                  candidate.threadId === row.threadId &&
                  candidate.platformMessageKey === input.data.platformMessageKey
              )
            ) {
              throw new Error("unique key conflict");
            }
            Object.assign(row, input.data);
            return row;
          }
        },
        messageAudioTranscription: {
          async update(input) {
            const row = transactionRows.find(
              (candidate) => candidate.audioTranscription?.id === input.where.id
            );
            if (!row) throw new Error("transcription missing");
            Object.assign(row.audioTranscription, input.data);
            return row.audioTranscription;
          }
        }
      };
      const result = await callback(transaction);
      rows = transactionRows;
      return result;
    }
  };
}

test("a verified inbound predecessor row is rekeyed without changing its identity", async () => {
  const legacy = existingRow();
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage()],
    existingRows: [legacy]
  });
  assert.deepEqual(plan.map(({ messageId, fromKey, toKey }) => ({ messageId, fromKey, toKey })), [
    {
      messageId: "message-legacy",
      fromKey: "instagram:legacy-0",
      toKey: "instagram:stable"
    }
  ]);

  const database = inMemoryDatabase([legacy]);
  await applyInstagramMessageKeyUpgradePlan(database, plan);

  assert.equal(database.rows().length, 1);
  assert.equal(database.rows()[0].id, "message-legacy");
  assert.equal(database.rows()[0].platformMessageKey, "instagram:stable");
});

test("a shifted occurrence candidate with a different source timestamp remains distinct", () => {
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage({ timestamp: "2026-08-21T10:00:00.000Z" })],
    existingRows: [existingRow()]
  });
  assert.deepEqual(plan, []);
});

test("exact timestamp evidence migrates a shifted legacy occurrence key", () => {
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage()],
    existingRows: [existingRow({ platformMessageKey: "instagram:legacy-7" })]
  });
  assert.equal(plan[0]?.fromKey, "instagram:legacy-7");
  assert.equal(plan[0]?.toKey, "instagram:stable");
});

test("an identity-less current snapshot fails closed around legacy history", () => {
  assert.throws(
    () =>
      planInstagramMessageKeyUpgrades({
        threadId: "thread-1",
        currentMessages: [currentMessage({ timestamp: undefined })],
        existingRows: [existingRow()]
      }),
    (error) =>
      error instanceof InstagramMessageKeyUpgradeError &&
      error.reason === "legacy_message_identity_ambiguous"
  );
});

test("malformed candidate provenance fails closed before any persistence", () => {
  assert.throws(
    () =>
      planInstagramMessageKeyUpgrades({
        threadId: "thread-1",
        currentMessages: [currentMessage()],
        existingRows: [existingRow({ rawJson: "not-json" })]
      }),
    (error) =>
      error instanceof InstagramMessageKeyUpgradeError &&
      error.reason === "malformed_legacy_provenance"
  );
});

test("an existing canonical row is left unchanged", () => {
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage()],
    existingRows: [
      existingRow({
        id: "canonical",
        platformMessageKey: "instagram:stable",
        rawJson: JSON.stringify({
          timestampSource: "source",
          contentKind: "text",
          messageIdentityVersion: "instagram_stable_v2"
        })
      })
    ]
  });
  assert.deepEqual(plan, []);
});

test("a canonical row plus a verified legacy twin fails closed", () => {
  assert.throws(
    () =>
      planInstagramMessageKeyUpgrades({
        threadId: "thread-1",
        currentMessages: [currentMessage()],
        existingRows: [
          existingRow(),
          existingRow({
            id: "canonical",
            platformMessageKey: "instagram:stable",
            rawJson: JSON.stringify({
              timestampSource: "source",
              contentKind: "text",
              messageIdentityVersion: "instagram_stable_v2"
            })
          })
        ]
      }),
    (error) =>
      error instanceof InstagramMessageKeyUpgradeError &&
      error.reason === "canonical_and_legacy_message_conflict"
  );
});

test("a later exact-layout receipt scan reconciles outside the outbound time window", () => {
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [
      currentMessage({
        direction: "OUT",
        timestamp: "2026-08-20T10:00:00.000Z",
        text: "Approved reply"
      })
    ],
    existingRows: [
      existingRow({
        direction: "OUT",
        timestamp: new Date("2026-08-20T10:00:45.000Z"),
        text: "Approved reply",
        rawJson: JSON.stringify({ verification: "exact_outgoing_layout_bubble" }),
        sentVia: "automation"
      })
    ]
  });
  assert.equal(plan[0]?.messageId, "message-legacy");
  assert.equal(plan[0]?.toKey, "instagram:stable");
});

test("audio fingerprints are migrated atomically with their owning message key", async () => {
  const legacy = existingRow({
    audioTranscription: {
      id: "transcription-1",
      audioFingerprint: "instagram:legacy-0|voice-1"
    }
  });
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage()],
    existingRows: [legacy]
  });
  const database = inMemoryDatabase([legacy]);

  await applyInstagramMessageKeyUpgradePlan(database, plan);

  assert.equal(
    database.rows()[0].audioTranscription.audioFingerprint,
    "instagram:stable|voice-1"
  );
});

test("an occupied target discovered during apply rolls back without deleting history", async () => {
  const legacy = existingRow();
  const plan = planInstagramMessageKeyUpgrades({
    threadId: "thread-1",
    currentMessages: [currentMessage()],
    existingRows: [legacy]
  });
  const canonical = existingRow({ id: "canonical", platformMessageKey: "instagram:stable" });
  const database = inMemoryDatabase([legacy, canonical]);

  await assert.rejects(
    () => applyInstagramMessageKeyUpgradePlan(database, plan),
    (error) =>
      error instanceof InstagramMessageKeyUpgradeError &&
      error.reason === "message_key_upgrade_race"
  );
  assert.deepEqual(
    database.rows().map((row) => row.platformMessageKey).sort(),
    ["instagram:legacy-0", "instagram:stable"]
  );
});
