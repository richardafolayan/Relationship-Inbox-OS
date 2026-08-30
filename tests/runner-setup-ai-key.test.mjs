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
const { summarizeControlBody } = await import("../apps/runner/src/services/control-audit.ts");

test("control audit summaries never contain an API key value", () => {
  const secret = "AQ.secret-key-01234567890123456789";
  const summary = summarizeControlBody({ key: secret, platform: "IMESSAGE" });
  assert.deepEqual(summary, {
    bodyKeys: ["key", "platform"],
    platform: "IMESSAGE",
    hasKey: true
  });
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

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

test("applyGeminiKey rejects a bad shape without validating, staging, or committing state", async () => {
  const calls = [];
  const result = await applyGeminiKey("   ", {
    validate: async () => {
      calls.push("validate");
      return { ok: true };
    },
    stage: () => {
      calls.push("stage");
      return { commit: () => calls.push("commit-key"), discard: () => calls.push("discard") };
    },
    commitState: async () => calls.push("commit-state"),
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(calls, []);
});

test("applyGeminiKey stops before staging when live validation fails", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: false, message: "nope" }),
    stage: () => {
      calls.push("stage");
      return { commit: () => undefined, discard: () => undefined };
    },
    commitState: async () => calls.push("commit-state"),
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.message, "nope");
  assert.deepEqual(calls, []);
});

test("applyGeminiKey promotes the staged key before enabling setup and then applies it", async () => {
  const calls = [];
  const result = await applyGeminiKey(`  ${"k".repeat(30)}  `, {
    validate: async (key) => {
      calls.push(["validate", key]);
      return { ok: true };
    },
    stage: (key) => {
      calls.push(["stage", key]);
      return {
        transactionId: "tx-success",
        commit: () => calls.push(["commit-key", key]),
        rollback: () => calls.push(["rollback-key", key]),
        finalize: () => calls.push(["finalize-key", key]),
        discard: () => calls.push(["discard", key])
      };
    },
    commitState: async (transactionId) => {
      calls.push(["commit-state", transactionId]);
      return { revision: 7 };
    },
    applyRuntime: (key) => calls.push(["apply", key])
  });
  assert.deepEqual(result, { ok: true, state: { revision: 7 } });
  assert.deepEqual(calls, [
    ["validate", "k".repeat(30)],
    ["stage", "k".repeat(30)],
    ["commit-key", "k".repeat(30)],
    ["commit-state", "tx-success"],
    ["finalize-key", "k".repeat(30)],
    ["apply", "k".repeat(30)]
  ]);
});

test("a failed setup transaction discards the staged key without changing env or runtime", async () => {
  const calls = [];
  await assert.rejects(
    applyGeminiKey("k".repeat(30), {
      validate: async () => ({ ok: true }),
      stage: () => ({
        transactionId: "tx-fail",
        commit: () => calls.push("commit-key"),
        rollback: () => calls.push("rollback-key"),
        finalize: () => calls.push("finalize-key"),
        discard: () => calls.push("discard")
      }),
      commitState: async (transactionId) => {
        assert.equal(transactionId, "tx-fail");
        calls.push("commit-state");
        throw new Error("setup transaction failed");
      },
      applyRuntime: () => calls.push("apply")
    }),
    /setup transaction failed/
  );
  assert.deepEqual(calls, ["commit-key", "commit-state", "rollback-key"]);
});

test("a cleanup failure after the durable commit still applies the saved key", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: true }),
    stage: () => ({
      transactionId: "tx-committed",
      commit: () => calls.push("commit-key"),
      rollback: () => calls.push("rollback-key"),
      finalize: () => {
        calls.push("finalize-key");
        throw new Error("cleanup unavailable");
      },
      discard: () => calls.push("discard")
    }),
    commitState: async () => {
      calls.push("commit-state");
      return { revision: 8 };
    },
    applyRuntime: () => calls.push("apply")
  });

  assert.deepEqual(result, { ok: true, state: { revision: 8 } });
  assert.deepEqual(calls, ["commit-key", "commit-state", "finalize-key", "apply"]);
});

test("a rollback cleanup failure preserves the original setup conflict", async () => {
  await assert.rejects(
    applyGeminiKey("k".repeat(30), {
      validate: async () => ({ ok: true }),
      stage: () => ({
        transactionId: "tx-conflict",
        commit: () => undefined,
        rollback: () => {
          throw new Error("rollback cleanup unavailable");
        },
        finalize: () => undefined,
        discard: () => undefined
      }),
      commitState: async () => {
        throw new Error("setup revision conflict");
      },
      applyRuntime: () => undefined
    }),
    /setup revision conflict/
  );
});

test("a staged-file promotion failure cannot advance setup state or apply runtime", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: true }),
    stage: () => ({
      commit: () => {
        throw new Error("EACCES");
      },
      rollback: () => calls.push("rollback"),
      finalize: () => calls.push("finalize"),
      discard: () => calls.push("discard")
    }),
    commitState: async () => {
      calls.push("commit-state");
      return { revision: 9 };
    },
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal("state" in result, false);
  assert.deepEqual(calls, ["discard"]);
});

test("upsertEnvFile staging remains invisible until commit and can be discarded", async () => {
  const {
    discardStaleEnvFileStages,
    stageEnvFileValue
  } = await import("../apps/runner/dist/services/setup-ai-key.js");
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-stage-"));
  const file = join(dir, ".env");
  writeFileSync(file, "GEMINI_API_KEY=old\n");
  try {
    const discarded = stageEnvFileValue(file, "GEMINI_API_KEY", "discarded");
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=old\n");
    discarded.discard();
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=old\n");

    const committed = stageEnvFileValue(file, "GEMINI_API_KEY", "new");
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=old\n");
    committed.commit();
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=new\n");
    committed.rollback();
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=old\n");

    writeFileSync(`${file}.crashed.pending`, "GEMINI_API_KEY=stale\n");
    discardStaleEnvFileStages(file);
    assert.throws(() => readFileSync(`${file}.crashed.pending`, "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup rolls back a promoted key whose setup transaction never committed", async () => {
  const {
    recoverEnvFileValueTransaction,
    stageEnvFileValue
  } = await import("../apps/runner/dist/services/setup-ai-key.js");
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-crash-"));
  const file = join(dir, ".env");
  writeFileSync(file, "GEMINI_API_KEY=old\n");
  try {
    const staged = stageEnvFileValue(file, "GEMINI_API_KEY", "new");
    staged.commit();
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=new\n");

    const recovered = recoverEnvFileValueTransaction(file, null);
    assert.equal(recovered, "rolled_back");
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=old\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup keeps a promoted key when the matching setup transaction committed", async () => {
  const {
    recoverEnvFileValueTransaction,
    stageEnvFileValue
  } = await import("../apps/runner/dist/services/setup-ai-key.js");
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-crash-"));
  const file = join(dir, ".env");
  writeFileSync(file, "GEMINI_API_KEY=old\n");
  try {
    const staged = stageEnvFileValue(file, "GEMINI_API_KEY", "new");
    staged.commit();
    const recovered = recoverEnvFileValueTransaction(file, staged.transactionId);
    assert.equal(recovered, "committed");
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=new\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup reads quoted dotenv values without keeping quotes or comments", async () => {
  const { readEnvFileValue } = await import("../apps/runner/dist/services/setup-ai-key.js");
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-read-"));
  const file = join(dir, ".env");
  writeFileSync(file, 'GEMINI_API_KEY="quoted-value" # operator note\n');
  try {
    assert.equal(readEnvFileValue(file, "GEMINI_API_KEY"), "quoted-value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup rejects a recovery journal whose backup escapes the config directory", async () => {
  const { recoverEnvFileValueTransaction } = await import(
    "../apps/runner/dist/services/setup-ai-key.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "rios-setup-ai-key-journal-"));
  const file = join(dir, ".env");
  writeFileSync(file, "GEMINI_API_KEY=current\n");
  writeFileSync(
    `${file}.setup-key-transaction.json`,
    JSON.stringify({
      transactionId: "123e4567-e89b-12d3-a456-426614174000",
      existed: true,
      backupName: "../outside"
    })
  );
  try {
    assert.throws(
      () => recoverEnvFileValueTransaction(file, null),
      /recovery journal is invalid/
    );
    assert.equal(readFileSync(file, "utf8"), "GEMINI_API_KEY=current\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyGeminiKey reports a staging failure before committing setup state", async () => {
  const calls = [];
  const result = await applyGeminiKey("k".repeat(30), {
    validate: async () => ({ ok: true }),
    stage: () => {
      throw new Error("EACCES");
    },
    commitState: async () => calls.push("commit-state"),
    applyRuntime: () => calls.push("apply")
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.deepEqual(calls, []);
});
