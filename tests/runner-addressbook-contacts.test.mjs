import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  readAllAddressBookContacts
} from "../apps/runner/dist/platforms/addressbook-db.js";
import {
  buildContactResolver,
  loadBestContactResolver
} from "../apps/runner/dist/services/contact-resolver.js";

// Issue #676: iMessage threads showed raw phone numbers because the resolver
// only read a manually-exported vCard that fresh installs never have. The fix
// reads the live macOS Contacts (AddressBook) databases directly. These tests
// build a minimal AddressBook .abcddb fixture and prove the reader + resolver
// turn handles into names — the same path that fixes a fresh pilot install.

// Build the minimal AddressBook schema the reader queries touch.
function buildAddressBookFixture(path, contacts) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZNICKNAME TEXT,
      ZORGANIZATION TEXT,
      ZBIRTHDAY REAL
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZFULLNUMBER TEXT
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZADDRESS TEXT
    );
  `);
  const insRec = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (?,?,?,?,?)"
  );
  const insPhone = db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?,?)"
  );
  const insEmail = db.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?,?)"
  );
  let pk = 0;
  for (const c of contacts) {
    pk += 1;
    insRec.run(
      pk,
      c.firstName ?? null,
      c.lastName ?? null,
      c.nickname ?? null,
      c.organization ?? null
    );
    for (const ph of c.phones ?? []) insPhone.run(pk, ph);
    for (const em of c.emails ?? []) insEmail.run(pk, em);
  }
  db.close();
}

function withFixture(contacts, fn) {
  const dir = mkdtempSync(join(tmpdir(), "addressbook-"));
  const path = join(dir, "AddressBook-v22.abcddb");
  buildAddressBookFixture(path, contacts);
  try {
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE = [
  {
    firstName: "Marianne",
    lastName: "Okafor",
    phones: ["+447700900123"],
    emails: ["marianne@example.com"]
  },
  // Organization-only card (no first/last/nickname) still yields a name.
  { organization: "Acme Ltd", phones: ["+15551234567"] },
  // Nameless card with a handle: must be dropped (nothing to resolve TO).
  { phones: ["+440000000000"] },
  // Named card with NO handle: must be dropped (nothing to resolve BY).
  { firstName: "Ghost", lastName: "NoHandle" }
];

test("readAllAddressBookContacts returns only named, handled contacts", () => {
  withFixture(SAMPLE, (path) => {
    const contacts = readAllAddressBookContacts([path]);
    const names = contacts.map((c) => c.name).sort();
    assert.deepEqual(names, ["Acme Ltd", "Marianne Okafor"]);
  });
});

test("buildContactResolver resolves AddressBook handles to names", () => {
  withFixture(SAMPLE, (path) => {
    const resolver = buildContactResolver(readAllAddressBookContacts([path]));
    // Phone matches on the trailing 10 digits, in any format.
    assert.equal(resolver.resolve("+447700900123"), "Marianne Okafor");
    assert.equal(resolver.resolve("07700900123"), "Marianne Okafor");
    assert.equal(resolver.resolve("07700 900123"), "Marianne Okafor");
    // Email matches case-insensitively.
    assert.equal(resolver.resolve("Marianne@Example.com"), "Marianne Okafor");
    // Org-only card resolves to the org name.
    assert.equal(resolver.resolve("+15551234567"), "Acme Ltd");
    // Dropped contacts never resolve.
    assert.equal(resolver.resolve("+440000000000"), null);
    assert.equal(resolver.resolve("+440000000001"), null);
  });
});

test("buildContactResolver([]) is the null resolver", () => {
  const resolver = buildContactResolver([]);
  assert.equal(resolver.resolve("+447700900123"), null);
  assert.equal(resolver.size(), 0);
});

test("loadBestContactResolver resolves a fresh install from the AddressBook (no vCard)", () => {
  withFixture(SAMPLE, (path) => {
    const resolver = loadBestContactResolver({
      addressBookDbPaths: [path],
      useAddressBook: true
      // no vcfPath — the fresh-pilot case
    });
    assert.equal(resolver.resolve("+447700900123"), "Marianne Okafor");
  });
});

test("loadBestContactResolver: a manual vCard wins on a handle collision", () => {
  withFixture(SAMPLE, (path, dir) => {
    const vcf = join(dir, "contacts.vcf");
    writeFileSync(
      vcf,
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Mari (work mobile)",
        "TEL:+447700900123",
        "END:VCARD",
        ""
      ].join("\n"),
      "utf8"
    );
    const resolver = loadBestContactResolver({
      addressBookDbPaths: [path],
      useAddressBook: true,
      vcfPath: vcf
    });
    // vCard override wins for the shared handle...
    assert.equal(resolver.resolve("+447700900123"), "Mari (work mobile)");
    // ...but AddressBook-only contacts still resolve.
    assert.equal(resolver.resolve("+15551234567"), "Acme Ltd");
  });
});

test("loadBestContactResolver with no sources is empty (off-Mac / no contacts)", () => {
  const resolver = loadBestContactResolver({ useAddressBook: false });
  assert.equal(resolver.size(), 0);
  assert.equal(resolver.resolve("+447700900123"), null);
});
