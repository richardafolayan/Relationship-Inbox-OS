import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPersistedWhatsAppSession,
  hasPersistedWhatsAppSession,
  whatsAppSessionDir
} from "../apps/runner/dist/platforms/whatsapp/session.js";

// Boot-time resume keys off this: a persisted LocalAuth session means the
// operator has linked a device and the client can reconnect without a QR.
// This is what makes an already-linked WhatsApp survive a runner restart, and
// covers the migration case (linked before the platforms row existed).

test("session dir is <authDir>/session-<clientId>", () => {
  assert.equal(whatsAppSessionDir("/data/wa"), "/data/wa/session-inbox-os");
  assert.equal(whatsAppSessionDir("/data/wa", "custom"), "/data/wa/session-custom");
});

test("no session when the auth dir does not exist", () => {
  assert.equal(hasPersistedWhatsAppSession("/nonexistent/path/xyz"), false);
});

test("no session when the session dir is empty", () => {
  const authDir = mkdtempSync(join(tmpdir(), "wa-empty-"));
  try {
    mkdirSync(whatsAppSessionDir(authDir), { recursive: true });
    assert.equal(hasPersistedWhatsAppSession(authDir), false);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("session detected when the session dir has contents", () => {
  const authDir = mkdtempSync(join(tmpdir(), "wa-live-"));
  try {
    const dir = whatsAppSessionDir(authDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ChromeFeatureState"), "x");
    assert.equal(hasPersistedWhatsAppSession(authDir), true);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("persisted session can be cleared for a clean relink", async () => {
  const authDir = mkdtempSync(join(tmpdir(), "wa-reset-"));
  try {
    const dir = whatsAppSessionDir(authDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Default"), "state");
    assert.equal(hasPersistedWhatsAppSession(authDir), true);

    await clearPersistedWhatsAppSession(authDir);

    assert.equal(hasPersistedWhatsAppSession(authDir), false);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});
