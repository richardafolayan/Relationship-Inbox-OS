import test from "node:test";
import assert from "node:assert/strict";
import { isLinkedInVoiceGuid } from "../apps/runner/dist/services/linkedin-voice-store.js";
import { stableMessageKey } from "../apps/runner/dist/linkedin/linkedinMessageKey.js";

// Regression for BUG PH1 — LinkedIn voice-message file keyed by the unstable
// positional bubble key, not the stable fingerprint.
//
// The backfill collector now captures a voice note AFTER computing the
// fingerprinted `stableBaseKey` and uses that single key as BOTH the
// voice-store urn and the attachment guid. For an id-less bubble that key is
// `li-msg-fp:...`, which does NOT start with `urn:li:`. The composite
// attachment resolver previously dispatched LinkedIn voice notes solely on the
// `urn:li:` prefix, so a fingerprint-keyed voice guid fell through to the
// iMessage resolver and the audio was silently dropped. `isLinkedInVoiceGuid`
// is the single dispatch predicate the resolver now uses; it must recognise
// every shape the message key can take.

test("isLinkedInVoiceGuid routes a real LinkedIn event URN to LinkedIn", () => {
  assert.equal(
    isLinkedInVoiceGuid("urn:li:msg_message:(urn:li:fsd_profile:abc,2-def==)"),
    true
  );
  assert.equal(isLinkedInVoiceGuid("urn:li:messagingMessage:2-abc=="), true);
});

test("isLinkedInVoiceGuid routes a fingerprint key (id-less bubble) to LinkedIn", () => {
  // This is the case the bug missed: id-less bubbles persist under the
  // fingerprint, so the voice guid is a `li-msg-fp:...` key.
  assert.equal(
    isLinkedInVoiceGuid("li-msg-fp:IN|Uwa Okungbowa|Feb 19|7:16 PM|Hi"),
    true
  );
});

test("isLinkedInVoiceGuid routes a legacy positional key to LinkedIn", () => {
  // Rows persisted before the fix may still carry the raw `li-msg-<index>`
  // guid; those must keep routing to the LinkedIn resolver too.
  assert.equal(isLinkedInVoiceGuid("li-msg-7"), true);
  assert.equal(isLinkedInVoiceGuid("li-msg-128"), true);
});

test("isLinkedInVoiceGuid does NOT claim a UUID-shaped iMessage guid", () => {
  assert.equal(isLinkedInVoiceGuid("3C3CA15E-7C18-4A1B-9F2D-0123456789AB"), false);
  assert.equal(isLinkedInVoiceGuid("p:1234567890"), false);
  assert.equal(isLinkedInVoiceGuid(""), false);
});

test("the guid an id-less voice bubble persists under routes to LinkedIn", () => {
  // End-to-end of the data-integrity invariant: the key the adapter uses as
  // BOTH the voice-store urn and the attachment guid is exactly the
  // fingerprint, and that fingerprint must dispatch to the LinkedIn resolver.
  const bubble = {
    existingKey: "li-msg-3", // positional fallback — bubble had no DOM id
    direction: "IN",
    senderName: "Uwa Okungbowa",
    dateHeading: "Feb 19",
    timeText: "7:16 PM",
    firstTextPart: "[voice message]"
  };
  const guid = stableMessageKey(bubble);
  assert.ok(guid.startsWith("li-msg-fp:"), "id-less bubble must use a fingerprint guid");
  assert.equal(
    isLinkedInVoiceGuid(guid),
    true,
    "the fingerprint voice guid must route to the LinkedIn resolver, not iMessage"
  );

  // And the fingerprint is stable across backfill passes, so the same bubble
  // re-keyed at a different index resolves to the same voice file.
  const laterPass = stableMessageKey({ ...bubble, existingKey: "li-msg-11" });
  assert.equal(guid, laterPass, "voice guid must be stable across backfill passes");
});
