import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createImessageNameSync } from "../apps/runner/dist/services/imessage-name-sync.js";

// Issue #676: existing iMessage rows imported before a contact source was wired
// in kept raw phone/email handles in Person.displayName and Message.senderName.
// The boot/daily name-sync repairs them from the live macOS Contacts. These
// tests use a fake Prisma + an AddressBook fixture so no real DB/Contacts are
// touched.

function buildAddressBookFixture(path, contacts) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZBIRTHDAY REAL
    );
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
  `);
  const insRec = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (?,?,?,?,?)"
  );
  const insPhone = db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?,?)");
  let pk = 0;
  for (const c of contacts) {
    pk += 1;
    insRec.run(pk, c.firstName ?? null, c.lastName ?? null, null, null);
    for (const ph of c.phones ?? []) insPhone.run(pk, ph);
  }
  db.close();
}

// Minimal Prisma stand-in: records every update so tests can assert exactly
// which rows were (and were not) rewritten.
function makeFakePrisma(persons, messages) {
  const personUpdates = [];
  const messageUpdates = [];
  return {
    prisma: {
      person: {
        findMany: async () => persons.map((p) => ({ id: p.id, displayName: p.displayName })),
        update: async ({ where, data }) => {
          personUpdates.push({ id: where.id, data });
          return {};
        }
      },
      message: {
        findMany: async () =>
          messages.map((m) => ({ id: m.id, senderName: m.senderName })),
        update: async ({ where, data }) => {
          messageUpdates.push({ id: where.id, data });
          return {};
        }
      }
    },
    personUpdates,
    messageUpdates
  };
}

function withFixture(contacts, fn) {
  const dir = mkdtempSync(join(tmpdir(), "name-sync-"));
  const path = join(dir, "AddressBook-v22.abcddb");
  buildAddressBookFixture(path, contacts);
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("name-sync rewrites raw-handle rows to AddressBook names and leaves real names alone", async () => {
  await withFixture([{ firstName: "Marianne", lastName: "Okafor", phones: ["+447538705144"] }], async (abPath) => {
    const fake = makeFakePrisma(
      [
        { id: "p-handle", displayName: "+447538705144" }, // resolves -> rewrite
        { id: "p-realname", displayName: "Tunde Bello" }, // already a name -> skip
        { id: "p-unmatched", displayName: "+449999999999" } // handle, no contact -> skip+count
      ],
      [
        { id: "m-handle", senderName: "+447538705144" }, // resolves -> rewrite
        { id: "m-realname", senderName: "Tunde Bello" } // already a name -> skip
      ]
    );
    const sync = createImessageNameSync({
      prisma: fake.prisma,
      addressBookDbPaths: [abPath],
      useAddressBook: true
    });

    const result = await sync.tick();

    assert.equal(result.personChanges, 1);
    assert.equal(result.messageChanges, 1);
    assert.equal(result.unresolvedHandleCount, 1);
    assert.ok(result.addressBookContactCount >= 1);

    // Exactly the handle person was rewritten, and inferredName cleared.
    assert.deepEqual(fake.personUpdates, [
      { id: "p-handle", data: { displayName: "Marianne Okafor", inferredName: null } }
    ]);
    // The real name and the unmatched handle were never touched.
    assert.ok(!fake.personUpdates.some((u) => u.id === "p-realname"));
    assert.ok(!fake.personUpdates.some((u) => u.id === "p-unmatched"));

    // Exactly the handle message sender was rewritten.
    assert.deepEqual(fake.messageUpdates, [
      { id: "m-handle", data: { senderName: "Marianne Okafor" } }
    ]);

    // Contacts exist on this Mac -> no empty-contacts hint.
    const health = sync.getHealth();
    assert.equal(health.shouldHintEmptyContacts, false);
    assert.equal(health.unresolvedImessageHandleCount, 1);
  });
});

test("name-sync flags an empty Mac address book when handles remain unresolved", async () => {
  const fake = makeFakePrisma(
    [
      { id: "p1", displayName: "+447538705144" },
      { id: "p2", displayName: "+15551234567" }
    ],
    []
  );
  // useAddressBook:false + no vCard simulates a Mac with an empty Contacts app.
  const sync = createImessageNameSync({
    prisma: fake.prisma,
    useAddressBook: false
  });

  const result = await sync.tick();

  assert.equal(result.contactsLoaded, 0);
  assert.equal(result.addressBookContactCount, 0);
  assert.equal(result.personChanges, 0);
  assert.equal(fake.personUpdates.length, 0);
  assert.equal(result.unresolvedHandleCount, 2);

  const health = sync.getHealth();
  assert.equal(health.shouldHintEmptyContacts, true);
  assert.equal(health.addressBookContactCount, 0);
  assert.equal(health.unresolvedImessageHandleCount, 2);
});

test("name-sync does not hint when there are no unresolved handles", async () => {
  // Empty contacts, but every person already has a real name -> nothing wrong,
  // so no hint even though the address book is empty.
  const fake = makeFakePrisma([{ id: "p1", displayName: "Adaeze Nwosu" }], []);
  const sync = createImessageNameSync({ prisma: fake.prisma, useAddressBook: false });

  await sync.tick();

  const health = sync.getHealth();
  assert.equal(health.shouldHintEmptyContacts, false);
  assert.equal(health.unresolvedImessageHandleCount, 0);
});
