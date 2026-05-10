import test from "node:test";
import assert from "node:assert/strict";
import { PlatformName } from "@prisma/client";
import { createNotImplementedAdapter } from "../apps/runner/dist/services/platform-factory.js";

test("Prisma PlatformName enum includes WHATSAPP", () => {
  assert.equal(PlatformName.WHATSAPP, "WHATSAPP");
});

test("Prisma PlatformName enum still has the existing platforms", () => {
  assert.equal(PlatformName.LINKEDIN, "LINKEDIN");
  assert.equal(PlatformName.INSTAGRAM, "INSTAGRAM");
  assert.equal(PlatformName.TIKTOK, "TIKTOK");
});

test("createNotImplementedAdapter exposes the platform field", () => {
  const adapter = createNotImplementedAdapter("WHATSAPP");
  assert.equal(adapter.platform, "WHATSAPP");
});

test("WHATSAPP stub adapter rejects scanUnreadThreads with a clear message", async () => {
  const adapter = createNotImplementedAdapter("WHATSAPP");
  await assert.rejects(adapter.scanUnreadThreads(), {
    message: "WHATSAPP adapter not yet implemented (scanUnreadThreads)"
  });
});

test("WHATSAPP stub adapter rejects sendMessage with a clear message", async () => {
  const adapter = createNotImplementedAdapter("WHATSAPP");
  await assert.rejects(
    adapter.sendMessage(
      { platformThreadId: "t1", displayName: "x", lastMessagePreview: "" },
      "hi"
    ),
    { message: "WHATSAPP adapter not yet implemented (sendMessage)" }
  );
});

test("WHATSAPP stub adapter rejects ensureConnected", async () => {
  const adapter = createNotImplementedAdapter("WHATSAPP");
  await assert.rejects(adapter.ensureConnected(), {
    message: "WHATSAPP adapter not yet implemented (ensureConnected)"
  });
});

test("WHATSAPP stub adapter rejects fetchRecentThreads", async () => {
  const adapter = createNotImplementedAdapter("WHATSAPP");
  await assert.rejects(adapter.fetchRecentThreads(10), {
    message: "WHATSAPP adapter not yet implemented (fetchRecentThreads)"
  });
});
