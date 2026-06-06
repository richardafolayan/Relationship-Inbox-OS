import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContactResolver } from "../apps/runner/dist/services/contact-resolver.js";

function withVcf(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "contact-resolver-"));
  const path = join(dir, "contacts.vcf");
  writeFileSync(path, contents, "utf8");
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Two DISTINCT people who happen to share the same display name (FN).
// siblingHandles() must never leak one person's handles to the other,
// otherwise pickBestSendHandle() could route an iMessage to the wrong
// recipient.
const SHARED_NAME_VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Alex Jordan",
  "TEL:+447111111111",
  "EMAIL:alex.a@example.com",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Alex Jordan",
  "TEL:+447222222222",
  "EMAIL:alex.b@example.com",
  "END:VCARD",
  ""
].join("\n");

test("siblingHandles does not cross-contaminate two contacts sharing a display name", () => {
  withVcf(SHARED_NAME_VCF, (path) => {
    const resolver = loadContactResolver(path);

    // Both entries still resolve to the shared name.
    assert.equal(resolver.resolve("+447111111111"), "Alex Jordan");
    assert.equal(resolver.resolve("+447222222222"), "Alex Jordan");

    // Person A's handle must only yield Person A's handles.
    const aSiblings = resolver.siblingHandles("+447111111111");
    assert.deepEqual(
      [...aSiblings].sort(),
      ["+447111111111", "alex.a@example.com"].sort()
    );
    assert.ok(
      !aSiblings.includes("alex.b@example.com"),
      "must not leak the other contact's email"
    );
    assert.ok(
      !aSiblings.includes("+447222222222"),
      "must not leak the other contact's phone"
    );

    // Person B's handle must only yield Person B's handles. Reached via
    // either the phone or the email.
    const bSiblings = resolver.siblingHandles("alex.b@example.com");
    assert.deepEqual(
      [...bSiblings].sort(),
      ["+447222222222", "alex.b@example.com"].sort()
    );
    assert.ok(!bSiblings.includes("alex.a@example.com"));
    assert.ok(!bSiblings.includes("+447111111111"));
  });
});

const SINGLE_CONTACT_VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Sam Rivera",
  "TEL:+447333333333",
  "EMAIL:sam@example.com",
  "END:VCARD",
  ""
].join("\n");

test("siblingHandles returns all of a single contact's handles", () => {
  withVcf(SINGLE_CONTACT_VCF, (path) => {
    const resolver = loadContactResolver(path);
    // Reached via the phone, returns phone + email.
    assert.deepEqual(
      [...resolver.siblingHandles("+447333333333")].sort(),
      ["+447333333333", "sam@example.com"].sort()
    );
    // Reached via the email, same pool.
    assert.deepEqual(
      [...resolver.siblingHandles("sam@example.com")].sort(),
      ["+447333333333", "sam@example.com"].sort()
    );
  });
});

test("siblingHandles returns the bare handle for an unknown contact", () => {
  withVcf(SINGLE_CONTACT_VCF, (path) => {
    const resolver = loadContactResolver(path);
    assert.deepEqual(resolver.siblingHandles("+447999999999"), ["+447999999999"]);
    assert.deepEqual(resolver.siblingHandles("nobody@example.com"), ["nobody@example.com"]);
  });
});
