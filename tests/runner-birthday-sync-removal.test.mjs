import test from "node:test";
import assert from "node:assert/strict";
import { createBirthdaySync } from "../apps/runner/dist/services/birthday-sync.js";

function createPrisma(person) {
  const updates = [];
  return {
    updates,
    prisma: {
      person: {
        async findMany() {
          return [{ ...person, threads: [] }];
        },
        async update({ data }) {
          Object.assign(person, data);
          updates.push(data);
          return person;
        }
      }
    }
  };
}

test("birthday sync clears a Contacts-sourced birthday after the contact removes it", async () => {
  const person = {
    id: "person-1",
    platform: "IMESSAGE",
    displayName: "+44 7700 900123",
    birthday: null,
    birthYear: null,
    birthdaySource: null
  };
  const { prisma, updates } = createPrisma(person);
  let birthdays = [
    {
      name: "Alice",
      monthDay: "05-12",
      year: 2001,
      phones: ["07700 900123"],
      emails: []
    }
  ];
  const contacts = [{ name: "Alice", phones: ["07700 900123"], emails: [] }];
  const sync = createBirthdaySync({
    prisma,
    readBirthdays: () => birthdays,
    readContacts: () => contacts,
    readChatHandles: () => new Map()
  });

  assert.deepEqual(await sync.tick(), { scanned: 1, matched: 1, updated: 1 });
  assert.equal(person.birthday, "05-12");
  assert.equal(person.birthdaySource, "macos_contacts");

  birthdays = [];
  assert.deepEqual(await sync.tick(), { scanned: 0, matched: 0, updated: 1 });
  assert.equal(person.birthday, null);
  assert.equal(person.birthYear, null);
  assert.equal(person.birthdaySource, null);
  assert.equal(updates.length, 2);
});

test("birthday sync does not clear anything when Contacts cannot be read", async () => {
  const person = {
    id: "person-1",
    platform: "IMESSAGE",
    displayName: "+44 7700 900123",
    birthday: "05-12",
    birthYear: 2001,
    birthdaySource: "macos_contacts"
  };
  const { prisma, updates } = createPrisma(person);
  const sync = createBirthdaySync({
    prisma,
    readBirthdays: () => [],
    readContacts: () => [],
    readChatHandles: () => new Map()
  });

  assert.deepEqual(await sync.tick(), { scanned: 0, matched: 0, updated: 0 });
  assert.equal(updates.length, 0);
  assert.equal(person.birthday, "05-12");
});
