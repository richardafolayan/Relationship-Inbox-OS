// Unit tests for the WhatsApp media helper. Covers:
//   - mapWhatsAppKind translating message types into AttachmentPlaceholder.kind
//   - safeIdForFilename stripping filesystem-hostile characters
//   - persistWhatsAppMedia writing the file and returning the right meta
//   - persistWhatsAppMedia idempotency (skips write when the file already exists)
//   - findWhatsAppMediaByGuid resolving back to disk
//
// The "writer" dep is faked so we don't touch real disk for the round-trip
// checks. The on-disk lookup test (findWhatsAppMediaByGuid) does write a
// temp file because the helper reads its own dir.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  mapWhatsAppKind,
  persistWhatsAppMedia,
  findWhatsAppMediaByGuid,
  safeIdForFilename
} from "../apps/runner/dist/platforms/whatsapp/media.js";

test("mapWhatsAppKind maps wweb.js message types", () => {
  assert.equal(mapWhatsAppKind("image"), "photo");
  assert.equal(mapWhatsAppKind("sticker"), "sticker");
  assert.equal(mapWhatsAppKind("video"), "video");
  assert.equal(mapWhatsAppKind("video", { isGif: true }), "gif");
  assert.equal(mapWhatsAppKind("ptt"), "voice_note");
  assert.equal(mapWhatsAppKind("audio"), "audio");
  assert.equal(mapWhatsAppKind("document"), "pdf");
  assert.equal(mapWhatsAppKind("chat"), "unknown");
  assert.equal(mapWhatsAppKind(undefined), "unknown");
});

test("safeIdForFilename strips colons, slashes, and at-signs", () => {
  const raw = "false_447xxx@c.us_ABCDEF123_447yyy@c.us";
  const clean = safeIdForFilename(raw);
  assert.equal(clean.includes("@"), false);
  assert.equal(clean.includes("/"), false);
  // _ . - and alphanumerics pass through.
  assert.match(clean, /^[A-Za-z0-9_.-]+$/);
});

test("persistWhatsAppMedia writes the file when missing", async () => {
  const writes = [];
  let dirCreated = false;
  let statCalls = 0;

  const meta = await persistWhatsAppMedia(
    "true_447xxx@c.us_ABCDEF",
    { mimetype: "image/jpeg", data: Buffer.from("hello").toString("base64") },
    {
      mediaDir: "/tmp/fake-media",
      writer: {
        mkdir: async (path, _opts) => {
          dirCreated = path === "/tmp/fake-media";
        },
        writeFile: async (path, data) => {
          writes.push({ path, byteLength: data.length });
        },
        stat: async () => {
          statCalls += 1;
          return { size: 5 };
        },
        exists: () => false
      }
    }
  );

  assert.equal(dirCreated, true, "mkdir should be called with the media dir");
  assert.equal(writes.length, 1, "writeFile should be called once");
  assert.equal(writes[0].byteLength, 5, "buffer length matches the input");
  assert.equal(statCalls, 1);
  assert.match(meta.filename, /\.jpg$/, "jpeg mime → .jpg extension");
  assert.equal(meta.mimetype, "image/jpeg");
  assert.equal(meta.byteSize, 5);
  assert.equal(meta.guid, "true_447xxx_c.us_ABCDEF");
});

test("persistWhatsAppMedia is idempotent when the file already exists", async () => {
  let writes = 0;
  await persistWhatsAppMedia(
    "raw_id",
    { mimetype: "image/png", data: Buffer.from("x").toString("base64") },
    {
      mediaDir: "/tmp/fake-media",
      writer: {
        mkdir: async () => {},
        writeFile: async () => {
          writes += 1;
        },
        stat: async () => ({ size: 0 }),
        exists: () => true
      }
    }
  );
  assert.equal(writes, 0, "should NOT re-write when the file exists");
});

test("persistWhatsAppMedia prefers media.filename extension over mime", async () => {
  const meta = await persistWhatsAppMedia(
    "doc_id",
    {
      mimetype: "application/octet-stream",
      data: Buffer.from("").toString("base64"),
      filename: "report.pdf"
    },
    {
      mediaDir: "/tmp/fake-media",
      writer: {
        mkdir: async () => {},
        writeFile: async () => {},
        stat: async () => ({ size: 0 }),
        exists: () => false
      }
    }
  );
  assert.match(meta.filename, /\.pdf$/);
});

test("findWhatsAppMediaByGuid resolves a real file on disk", async () => {
  const root = await mkdir(join(tmpdir(), `wa-media-test-${Date.now()}`), { recursive: true });
  try {
    const guid = "true_447xxx_c.us_ABCDEF";
    const filePath = resolve(join(root, `${guid}.jpg`));
    await writeFile(filePath, Buffer.from("hello"));
    const meta = await findWhatsAppMediaByGuid(guid, root);
    assert.ok(meta, "expected a hit for a file we just wrote");
    assert.equal(meta.absolutePath, filePath);
    assert.equal(meta.mimetype, "image/jpeg");
    assert.equal(meta.byteSize, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findWhatsAppMediaByGuid returns null for a guid that isn't on disk", async () => {
  const root = await mkdir(join(tmpdir(), `wa-media-empty-${Date.now()}`), { recursive: true });
  try {
    const meta = await findWhatsAppMediaByGuid("does_not_exist", root);
    assert.equal(meta, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
