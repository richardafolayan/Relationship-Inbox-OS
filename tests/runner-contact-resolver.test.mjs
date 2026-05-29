import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContactResolver } from "../apps/runner/src/services/contact-resolver.ts";

function withVcf(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ribos-vcf-"));
  const path = join(dir, "contacts.vcf");
  writeFileSync(path, lines.join("\n"), "utf8");
  try {
    fn(loadContactResolver(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("siblingHandles returns the owning contact's handles, never a namesake's", () => {
  // Two distinct "David Smith" contacts. The first owns 0711..., the second
  // owns a different number plus an email. The display name collides; the
  // handles do not.
  withVcf(
    [
      "BEGIN:VCARD", "FN:David Smith", "TEL:+447111111111", "END:VCARD",
      "BEGIN:VCARD", "FN:David Smith", "TEL:+447222222222", "EMAIL:other.david@example.com", "END:VCARD"
    ],
    (resolver) => {
      const siblings = resolver.siblingHandles("+447111111111");
      // Must be the first David's handles only — the second David's email
      // must not become a send target for the first David's thread.
      assert.deepEqual(siblings, ["+447111111111"]);
      assert.equal(siblings.includes("other.david@example.com"), false);
    }
  );
});

test("a handle shared by two contacts is ambiguous, attributed to neither", () => {
  // +1 555 000 1111 and +44 7555 000 1111 both collapse to the trailing
  // 10-digit key 5550001111.
  withVcf(
    [
      "BEGIN:VCARD", "FN:Alice", "TEL:+15550001111", "END:VCARD",
      "BEGIN:VCARD", "FN:Bob", "TEL:+447555 000 1111", "END:VCARD"
    ],
    (resolver) => {
      assert.equal(resolver.resolve("+15550001111"), null);
      // Never expand an ambiguous handle into another contact's addresses.
      assert.deepEqual(resolver.siblingHandles("+15550001111"), ["+15550001111"]);
    }
  );
});

test("a uniquely-owned handle resolves and expands to its real siblings", () => {
  withVcf(
    [
      "BEGIN:VCARD", "FN:Carol", "TEL:+447900900900", "EMAIL:carol@example.com", "END:VCARD"
    ],
    (resolver) => {
      assert.equal(resolver.resolve("+447900900900"), "Carol");
      assert.equal(resolver.resolve("CAROL@example.com"), "Carol");
      const siblings = resolver.siblingHandles("07900 900900");
      assert.equal(siblings.includes("+447900900900"), true);
      assert.equal(siblings.includes("carol@example.com"), true);
    }
  );
});

test("an unknown handle resolves to null and returns only itself", () => {
  withVcf(
    ["BEGIN:VCARD", "FN:Carol", "TEL:+447900900900", "END:VCARD"],
    (resolver) => {
      assert.equal(resolver.resolve("+440000000000"), null);
      assert.deepEqual(resolver.siblingHandles("+440000000000"), ["+440000000000"]);
    }
  );
});
