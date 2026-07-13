import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// First-run setup wizard (#845): the /control/setup/ai-key save path.
// Covers the pure .env parse-and-update, the key shape check, the atomic
// file upsert, live validation outcomes, and the applyGeminiKey
// orchestration (validate before persist, persist before apply).
const {
  applyGeminiKey,
  isPlausibleApiKeyShape,
  resolveEnvWritePath,
  upsertEnvContent,
  upsertEnvFile,
  validateGeminiKey
} = await import("../apps/runner/dist/services/setup-ai-key.js");

test("upsertEnvContent updates an existing key and preserves everything else", () => {
  const content = [
    "# runner config",
    "RUNNER_PORT=4001",
    "GEMINI_API_KEY=old-value",
    "",
    "OPENAI_API_KEY=sk-keep-me"
  ].join("\n");
  const next = upsertEnvContent(content, "GEMINI_API_KEY", "new-value");
  assert.equal(
    next,
    ["# runner config", "RUNNER_PORT=4001", "GEMINI_API_KEY=new-value", "", "OPENAI_API_KEY=sk-keep-me", ""].join(
      "\n"
    )
  );
});

test("upsertEnvContent appends when the key is missing and ends with one newline", () => {
  assert.equal(
    upsertEnvContent("RUNNER_PORT=4001\n\n\n", "GEMINI_API_KEY", "abc"),
    "RUNNER_PORT=4001\nGEMINI_API_KEY=abc\n"
  );
  assert.equal(upsertEnvContent("", "GEMINI_API_KEY", "abc"), "GEMINI_API_KEY=abc\n");
});

test("upsertEnvContent matches export-prefixed lines and only the first occurrence", () => {
  const next = upsertEnvContent(
    "export GEMINI_API_KEY=one\nGEMINI_API_KEY=two\n",
    "GEMINI_API_KEY",
    "three"
  );
  assert.equal(next, "GEMINI_API_KEY=three\nGEMINI_API_KEY=two\n");
});

test("upsertEnvContent does not touch keys that merely share a prefix", () => {
  const next = upsertEnvContent("GEMINI_API_KEY_BACKUP=keep\n", "GEMINI_API_KEY", "abc");
  assert.equal(next, "GEMINI_API_KEY_BACKUP=keep\nGEMINI_API_KEY=abc\n");
});

test("isPlausibleApiKeyShape rejects paste accidents and accepts key-like strings", () => {
  assert.equal(isPlausibleApiKeyShape("AIzaSyExample-Key_0123456789abc"), true);
  assert.equal(isPlausibleApiKeyShape(""), false);
  assert.equal(isPlausibleApiKeyShape("short"), false);
  assert.equal(isPlausibleApiKeyShape("has spaces in the middle 123456789"), false);
  assert.equal(isPlausibleApiKeyShape("line\nbreak0123456789012345678"), false);
  assert.equal(isPlausibleApiKeyShape('"AIzaQuoted0123456789012345678"'), false);
});

test("upsertEnvFile writes atomically and preserves unrelated keys on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-"));
  const file = join(dir, ".env");
  writeFileSync(file, "RUNNER_PORT=4501\n# note\n");
  try {
    upsertEnvFile(file, "GEMINI_API_KEY", "abc123");
    assert.equal(readFileSync(file, "utf8"), "RUNNER_PORT=4501\n# note\nGEMINI_API_KEY=abc123\n");
    upsertEnvFile(file, "GEMINI_API_KEY", "def456");
    assert.equal(readFileSync(file, "utf8"), "RUNNER_PORT=4501\n# note\nGEMINI_API_KEY=def456\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertEnvFile creates the file when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-"));
  const file = join(dir, ".env");
  try {
    upsertEnvFile(file, "GEMINI_API_KEY", "abc123");
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=abc123\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEnvWritePath prefers RIOS_CONFIG_DIR over cwd", () => {
  assert.equal(
    resolveEnvWritePath({ RIOS_CONFIG_DIR: "/tmp/rios-config" }),
    "/tmp/rios-config/.env"
  );
  assert.equal(resolveEnvWritePath({}), join(process.cwd(), ".env"));
});

test("validateGeminiKey distinguishes bad key, network failure, and success", async () => {
  const okFetch = async () => new Response("{}", { status: 200 });
  const authFail = async () => new Response("{}", { status: 401 });
  const serverFail = async () => new Response("{}", { status: 500 });
  const networkFail = async () => {
    throw new Error("ECONNREFUSED");
  };
  const base = "https://example.test/v1beta/openai/";

  assert.deepEqual(await validateGeminiKey("k".repeat(30), base, okFetch), { ok: true });
  const bad = await validateGeminiKey("k".repeat(30), base, authFail);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /didn't accept/);
  const down = await validateGeminiKey("k".repeat(30), base, networkFail);
  assert.equal(down.ok, false);
  assert.match(down.message, /internet connection/);
  const flaky = await validateGeminiKey("k".repeat(30), base, serverFail);
  assert.equal(flaky.ok, false);
  assert.match(flaky.message, /unexpected error/);
});

test("validateGeminiKey hits the models listing with a bearer header", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return new Response("{}", { status: 200 });
  };
  await validateGeminiKey("secret-key-0123456789012345", "https://example.test/openai/", fetchImpl);
  assert.equal(seenUrl, "https://example.test/openai/models");
  assert.equal(seenAuth, "Bearer secret-key-0123456789012345");
});

test("applyGeminiKey rejects a bad shape without validating or persisting", async () => {
  const calls = [];
  const result = await applyGeminiKey("   ", {
    validate: async () => {
      calls.push("validate");
      return { ok: true };
    },
    persist: () => calls.push("persist"),
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(calls, []);
});

test("applyGeminiKey stops before persisting when live validation fails", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: false, message: "nope" }),
    persist: () => calls.push("persist"),
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.message, "nope");
  assert.deepEqual(calls, []);
});

test("applyGeminiKey persists the trimmed key then applies it to the runtime", async () => {
  const calls = [];
  const result = await applyGeminiKey(`  ${"k".repeat(30)}  `, {
    validate: async (key) => {
      calls.push(["validate", key]);
      return { ok: true };
    },
    persist: (key) => calls.push(["persist", key]),
    applyRuntime: (key) => calls.push(["apply", key])
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ["validate", "k".repeat(30)],
    ["persist", "k".repeat(30)],
    ["apply", "k".repeat(30)]
  ]);
});

test("applyGeminiKey reports a persist failure without applying to the runtime", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: true }),
    persist: () => {
      throw new Error("EACCES");
    },
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.deepEqual(calls, []);
});
