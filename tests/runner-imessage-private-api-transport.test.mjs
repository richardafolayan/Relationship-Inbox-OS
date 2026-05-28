import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";

import { sendHelperRequest } from "../apps/runner/dist/platforms/imessage-private-api/helper-bridge.js";
import { createHealthProbe } from "../apps/runner/dist/platforms/imessage-private-api/health.js";
import {
  createPrivateApiHelper,
  PrivateApiError
} from "../apps/runner/dist/platforms/imessage-private-api/index.js";

// A real UNIX-socket server standing in for the helper bundle / mock. `handler`
// receives each decoded request and returns the response object to write back,
// or the sentinel SILENT to deliberately never reply (timeout testing).
const SILENT = Symbol("silent");
async function startHelperServer(handler) {
  const socketPath = join(tmpdir(), `imsg-helper-test-${randomUUID()}.sock`);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const response = handler(JSON.parse(line));
        if (response === SILENT) continue;
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
    }
  };
}

const ok = (req, result = {}) => ({ id: req.id, ok: true, result });
const err = (req, code, message = code) => ({ id: req.id, ok: false, error: { code, message } });

test("bridge: ping round-trips and returns the result", async () => {
  const srv = await startHelperServer((req) => ok(req, { helper: "test", protocol: 1 }));
  try {
    const result = await sendHelperRequest({ socketPath: srv.socketPath, timeoutMs: 1000 }, "ping", {});
    assert.equal(result.helper, "test");
  } finally {
    await srv.close();
  }
});

test("bridge: threaded reply returns the assigned guid", async () => {
  const srv = await startHelperServer((req) => {
    assert.equal(req.op, "sendThreadedReply");
    assert.equal(req.params.chatGuid, "chat-1");
    assert.equal(req.params.parentMessageGuid, "parent-1");
    return ok(req, { messageGuid: "new-guid" });
  });
  try {
    const result = await sendHelperRequest(
      { socketPath: srv.socketPath, timeoutMs: 1000 },
      "sendThreadedReply",
      { chatGuid: "chat-1", parentMessageGuid: "parent-1", text: "hi" }
    );
    assert.equal(result.messageGuid, "new-guid");
  } finally {
    await srv.close();
  }
});

test("bridge: a helper error rejects with the structured code", async () => {
  const srv = await startHelperServer((req) => err(req, "unsupported_kind", "iOS 18 emoji"));
  try {
    await assert.rejects(
      () =>
        sendHelperRequest({ socketPath: srv.socketPath, timeoutMs: 1000 }, "sendTapback", {
          chatGuid: "c",
          targetMessageGuid: "t",
          kind: "heart",
          action: "add"
        }),
      (e) => e instanceof PrivateApiError && e.code === "unsupported_kind"
    );
  } finally {
    await srv.close();
  }
});

test("bridge: a missing socket is a transport error (fast)", async () => {
  const socketPath = join(tmpdir(), `imsg-absent-${randomUUID()}.sock`);
  const start = Date.now();
  await assert.rejects(
    () => sendHelperRequest({ socketPath, timeoutMs: 1000 }, "ping", {}),
    (e) => e instanceof PrivateApiError && e.code === "transport"
  );
  assert.ok(Date.now() - start < 500, "unreachable socket should fail quickly, not hang");
});

test("bridge: a hung helper times out as a transport error", async () => {
  const srv = await startHelperServer(() => SILENT);
  try {
    await assert.rejects(
      () => sendHelperRequest({ socketPath: srv.socketPath, timeoutMs: 120 }, "ping", {}),
      (e) => e instanceof PrivateApiError && e.code === "transport" && /timed out/.test(e.message)
    );
  } finally {
    await srv.close();
  }
});

test("bridge: a mismatched response id is rejected", async () => {
  const srv = await startHelperServer(() => ({ id: "WRONG", ok: true, result: {} }));
  try {
    await assert.rejects(
      () => sendHelperRequest({ socketPath: srv.socketPath, timeoutMs: 1000 }, "ping", {}),
      (e) => e instanceof PrivateApiError && e.code === "transport"
    );
  } finally {
    await srv.close();
  }
});

test("health: disabled never touches the socket and reports unreachable", async () => {
  let connects = 0;
  const srv = await startHelperServer((req) => {
    connects += 1;
    return ok(req);
  });
  try {
    const probe = createHealthProbe({
      enabled: false,
      socketPath: srv.socketPath,
      probeTimeoutMs: 500,
      cacheMs: 1000
    });
    assert.equal(await probe.isReachable(), false);
    assert.equal(connects, 0, "disabled probe must not connect");
  } finally {
    await srv.close();
  }
});

test("health: reachable when up, caches across clock, re-probes after invalidate", async () => {
  const clock = { t: 0 };
  const srv = await startHelperServer((req) => ok(req));
  const probe = createHealthProbe({
    enabled: true,
    socketPath: srv.socketPath,
    probeTimeoutMs: 500,
    cacheMs: 1000,
    now: () => clock.t
  });
  assert.equal(await probe.isReachable(), true);

  // Take the helper down; within the cache window it still reports reachable.
  await srv.close();
  clock.t = 500;
  assert.equal(await probe.isReachable(), true, "cached positive within cacheMs");

  // After the cache expires it re-probes and discovers the helper is gone.
  clock.t = 1500;
  assert.equal(await probe.isReachable(), false, "re-probe after cacheMs sees it down");

  // invalidate() forces an immediate re-probe regardless of the clock.
  probe.invalidate();
  assert.equal(await probe.isReachable(), false);
});

test("facade: native sends succeed when reachable", async () => {
  const srv = await startHelperServer((req) => {
    if (req.op === "ping") return ok(req);
    if (req.op === "sendThreadedReply") return ok(req, { messageGuid: "g-123" });
    if (req.op === "sendTapback") return ok(req);
    return err(req, "unsupported_op");
  });
  try {
    const helper = createPrivateApiHelper({
      enabled: true,
      socketPath: srv.socketPath,
      requestTimeoutMs: 1000,
      healthCacheMs: 0 // always re-probe so the test is deterministic
    });
    assert.equal(helper.enabled, true);
    assert.equal(await helper.isReachable(), true);
    const reply = await helper.sendThreadedReply({
      chatGuid: "c",
      parentMessageGuid: "p",
      text: "yo"
    });
    assert.equal(reply.messageGuid, "g-123");
    await helper.sendTapback({ chatGuid: "c", targetMessageGuid: "t", kind: "heart", action: "add" });
  } finally {
    await srv.close();
  }
});

test("facade: unsupported_kind propagates so the caller can degrade", async () => {
  const srv = await startHelperServer((req) =>
    req.op === "ping" ? ok(req) : err(req, "unsupported_kind", "no")
  );
  try {
    const helper = createPrivateApiHelper({
      enabled: true,
      socketPath: srv.socketPath,
      requestTimeoutMs: 1000,
      healthCacheMs: 0
    });
    await assert.rejects(
      () => helper.sendTapback({ chatGuid: "c", targetMessageGuid: "t", kind: "question", action: "add" }),
      (e) => e instanceof PrivateApiError && e.code === "unsupported_kind"
    );
  } finally {
    await srv.close();
  }
});

test("facade: disabled helper reports unreachable (fallback path)", async () => {
  const helper = createPrivateApiHelper({
    enabled: false,
    socketPath: join(tmpdir(), `imsg-${randomUUID()}.sock`),
    requestTimeoutMs: 1000,
    healthCacheMs: 1000
  });
  assert.equal(helper.enabled, false);
  assert.equal(await helper.isReachable(), false);
});

test("facade: a transport failure invalidates cached reachability", async () => {
  const srv = await startHelperServer((req) => ok(req));
  const helper = createPrivateApiHelper({
    enabled: true,
    socketPath: srv.socketPath,
    requestTimeoutMs: 200,
    healthCacheMs: 60_000 // long cache: only invalidate() should clear it
  });
  assert.equal(await helper.isReachable(), true);

  // Helper goes away; the next native send fails at the transport layer.
  await srv.close();
  await assert.rejects(
    () => helper.sendThreadedReply({ chatGuid: "c", parentMessageGuid: "p", text: "x" }),
    (e) => e instanceof PrivateApiError
  );

  // Despite the long cache, the failed send invalidated reachability, so the
  // next isReachable() re-probes and correctly reports the helper down.
  assert.equal(await helper.isReachable(), false);
});
