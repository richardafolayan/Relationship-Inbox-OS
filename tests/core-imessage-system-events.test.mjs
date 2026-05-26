import test from "node:test";
import assert from "node:assert/strict";
import { isNonContentIMessageSystemEvent } from "@inbox-os/core";

test("matches '<name> kept an audio message from you.'", () => {
  assert.equal(isNonContentIMessageSystemEvent("Seyi kept an audio message from you."), true);
  assert.equal(isNonContentIMessageSystemEvent("Marianne Acheampong kept an audio message from you."), true);
});

test("matches 'You kept an audio message from <name>.'", () => {
  assert.equal(isNonContentIMessageSystemEvent("You kept an audio message from Lanre."), true);
  assert.equal(isNonContentIMessageSystemEvent("You kept an audio message from +447951711949."), true);
});

test("matches the shorter '<name> kept an audio message.' form", () => {
  assert.equal(isNonContentIMessageSystemEvent("Praise kept an audio message."), true);
});

test("matches the shorter 'You kept an audio message.' form", () => {
  assert.equal(isNonContentIMessageSystemEvent("You kept an audio message."), true);
});

test("matches trailing whitespace and missing trailing period", () => {
  assert.equal(isNonContentIMessageSystemEvent("Seyi kept an audio message from you"), true);
  assert.equal(isNonContentIMessageSystemEvent("Seyi kept an audio message from you.\n"), true);
  assert.equal(isNonContentIMessageSystemEvent("  Seyi kept an audio message from you.  "), true);
});

test("matches case-insensitively", () => {
  assert.equal(isNonContentIMessageSystemEvent("SEYI KEPT AN AUDIO MESSAGE FROM YOU."), true);
  assert.equal(isNonContentIMessageSystemEvent("seyi kept an audio message from you."), true);
});

test("does not match normal text that mentions an audio message", () => {
  assert.equal(
    isNonContentIMessageSystemEvent("Can you believe she kept an audio message I sent ages ago?"),
    false
  );
  assert.equal(
    isNonContentIMessageSystemEvent("Why did you keep that audio message from him?"),
    false
  );
  assert.equal(
    isNonContentIMessageSystemEvent("I had to keep an audio message from her for evidence."),
    false
  );
});

test("does not match empty / nullish input", () => {
  assert.equal(isNonContentIMessageSystemEvent(null), false);
  assert.equal(isNonContentIMessageSystemEvent(undefined), false);
  assert.equal(isNonContentIMessageSystemEvent(""), false);
  assert.equal(isNonContentIMessageSystemEvent("   "), false);
});

test("does not match shoutout-style sentences", () => {
  assert.equal(isNonContentIMessageSystemEvent("Yeah I kept your message"), false);
  assert.equal(isNonContentIMessageSystemEvent("kept an audio message you sent"), false);
});
