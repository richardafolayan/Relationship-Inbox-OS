import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJid,
  isGroupJid,
  isContactJid,
  isBroadcastJid,
  jidToPhoneNumber,
  phoneNumberToContactJid
} from "../apps/runner/dist/platforms/whatsapp/whatsappIdentity.js";

test("parseJid identifies a 1:1 contact JID", () => {
  const parsed = parseJid("447111222333@c.us");
  assert.deepEqual(parsed, {
    raw: "447111222333@c.us",
    kind: "contact",
    local: "447111222333",
    domain: "c.us"
  });
});

test("parseJid identifies a group JID", () => {
  const parsed = parseJid("12345-67890@g.us");
  assert.equal(parsed?.kind, "group");
  assert.equal(parsed?.local, "12345-67890");
});

test("parseJid identifies the s.whatsapp.net contact suffix as a contact", () => {
  assert.equal(parseJid("447111222333@s.whatsapp.net")?.kind, "contact");
});

test("parseJid returns null for empty / null / malformed input", () => {
  assert.equal(parseJid(null), null);
  assert.equal(parseJid(""), null);
  assert.equal(parseJid("@c.us"), null);
  assert.equal(parseJid("no-at-sign"), null);
});

test("isGroupJid is true only for @g.us suffix", () => {
  assert.equal(isGroupJid("12345-67890@g.us"), true);
  assert.equal(isGroupJid("447111222333@c.us"), false);
});

test("isContactJid is true for both @c.us and @s.whatsapp.net", () => {
  assert.equal(isContactJid("447111222333@c.us"), true);
  assert.equal(isContactJid("447111222333@s.whatsapp.net"), true);
  assert.equal(isContactJid("12345@g.us"), false);
});

test("isBroadcastJid is true only for the @broadcast suffix", () => {
  assert.equal(isBroadcastJid("status@broadcast"), true);
  assert.equal(isBroadcastJid("12345678@broadcast"), true);
  assert.equal(isBroadcastJid("447111222333@c.us"), false);
  assert.equal(isBroadcastJid("12345-67890@g.us"), false);
  assert.equal(isBroadcastJid(null), false);
});

test("jidToPhoneNumber extracts digits from a contact JID", () => {
  assert.equal(jidToPhoneNumber("447111222333@c.us"), "447111222333");
});

test("jidToPhoneNumber strips a linked-device suffix", () => {
  assert.equal(jidToPhoneNumber("447111222333:42@c.us"), "447111222333");
});

test("jidToPhoneNumber returns null for group JIDs", () => {
  assert.equal(jidToPhoneNumber("12345-67890@g.us"), null);
});

test("phoneNumberToContactJid produces the canonical @c.us form", () => {
  assert.equal(phoneNumberToContactJid("+44 7111 222333"), "447111222333@c.us");
  assert.equal(phoneNumberToContactJid("447111222333"), "447111222333@c.us");
});
