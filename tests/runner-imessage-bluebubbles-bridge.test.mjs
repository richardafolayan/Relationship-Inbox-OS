import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Exercises tools/bluebubbles-helper-bridge.mjs (the #273 "real helper"): it
// must speak the runner's NDJSON socket protocol and forward each op to a
// BlueBubbles server's REST API. We stand up a FAKE BlueBubbles HTTP server and
// assert the bridge calls the right endpoint with the right mapped fields, and
// that auth/config failures surface as clean protocol errors.

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, "../tools/bluebubbles-helper-bridge.mjs");

/** Fake BlueBubbles server. `responder(req)` returns { status, body }. */
function startFakeBlueBubbles(responder) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const entry = {
        method: req.method,
        path: url.pathname,
        password: url.searchParams.get("password"),
        body: raw ? JSON.parse(raw) : null
      };
      received.push(entry);
      const { status = 200, body = { status: 200, data: null } } = responder(entry) ?? {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolveReady) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveReady({ url: `http://127.0.0.1:${port}`, received, close: () => server.close() });
    });
  });
}

function startBridge(env) {
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  return { proc, getStderr: () => stderr };
}

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const ok = await new Promise((res) => {
        const s = net.connect(socketPath, () => {
          s.end();
          res(true);
        });
        s.on("error", () => res(false));
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Send one NDJSON request over the socket and resolve the single response. */
function rpc(socketPath, request) {
  return new Promise((resolveRpc, reject) => {
    const socket = net.connect(socketPath, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        socket.end();
        try {
          resolveRpc(JSON.parse(buffer.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("rpc timeout")), 4000);
  });
}

function tmpSocket(tag) {
  return `/tmp/bb-bridge-test-${tag}-${process.pid}.sock`;
}

test("bridge forwards ping, threaded reply, and tapback add/remove to BlueBubbles", async () => {
  const socketPath = tmpSocket("ok");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const bb = await startFakeBlueBubbles((req) => {
    if (req.path === "/api/v1/ping") return { body: { status: 200, message: "pong", data: null } };
    if (req.path === "/api/v1/message/text") return { body: { status: 200, data: { guid: "bb-reply-guid" } } };
    if (req.path === "/api/v1/message/react") return { body: { status: 200, data: { guid: "bb-react-guid" } } };
    return { status: 404, body: { status: 404, message: "not found" } };
  });
  const { proc } = startBridge({
    BLUEBUBBLES_SERVER_URL: bb.url,
    BLUEBUBBLES_PASSWORD: "s3cret",
    IMESSAGE_PRIVATE_API_SOCKET: socketPath
  });

  try {
    assert.equal(await waitForSocket(socketPath), true, "bridge should listen on the socket");

    // ping
    const ping = await rpc(socketPath, { id: "1", op: "ping", params: {} });
    assert.equal(ping.ok, true);
    assert.equal(ping.result.helper, "bluebubbles-bridge");
    assert.deepEqual(ping.result.capabilities.tapbackKinds, [
      "heart",
      "like",
      "dislike",
      "laugh",
      "emphasize",
      "question"
    ]);

    // threaded reply → POST /message/text with private-api + reply target
    const reply = await rpc(socketPath, {
      id: "2",
      op: "sendThreadedReply",
      params: { chatGuid: "iMessage;-;+15551230001", parentMessageGuid: "PARENT-GUID", text: "on my way" }
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.messageGuid, "bb-reply-guid", "returns the BlueBubbles message guid for dedup");
    const textReq = bb.received.find((r) => r.path === "/api/v1/message/text");
    assert.equal(textReq.method, "POST");
    assert.equal(textReq.password, "s3cret", "password forwarded as query param");
    assert.equal(textReq.body.chatGuid, "iMessage;-;+15551230001");
    assert.equal(textReq.body.message, "on my way");
    assert.equal(textReq.body.method, "private-api");
    assert.equal(textReq.body.selectedMessageGuid, "PARENT-GUID");

    // tapback add: heart → BlueBubbles "love"
    const add = await rpc(socketPath, {
      id: "3",
      op: "sendTapback",
      params: { chatGuid: "iMessage;-;+15551230001", targetMessageGuid: "TGT-GUID", kind: "heart", action: "add" }
    });
    assert.equal(add.ok, true);
    const reactAdd = bb.received.find((r) => r.path === "/api/v1/message/react");
    assert.equal(reactAdd.body.reaction, "love", "heart maps to BlueBubbles 'love'");
    assert.equal(reactAdd.body.selectedMessageGuid, "TGT-GUID");

    // tapback remove: heart → "-love"
    const remove = await rpc(socketPath, {
      id: "4",
      op: "sendTapback",
      params: { chatGuid: "iMessage;-;+15551230001", targetMessageGuid: "TGT-GUID", kind: "heart", action: "remove" }
    });
    assert.equal(remove.ok, true);
    const reactRemove = bb.received.filter((r) => r.path === "/api/v1/message/react").at(-1);
    assert.equal(reactRemove.body.reaction, "-love", "remove sends the '-'-prefixed reaction");
  } finally {
    proc.kill("SIGTERM");
    bb.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
});

test("bridge surfaces a clear error when BlueBubbles rejects the password", async () => {
  const socketPath = tmpSocket("auth");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const bb = await startFakeBlueBubbles(() => ({ status: 401, body: { status: 401, message: "Unauthorized" } }));
  const { proc } = startBridge({
    BLUEBUBBLES_SERVER_URL: bb.url,
    BLUEBUBBLES_PASSWORD: "wrong",
    IMESSAGE_PRIVATE_API_SOCKET: socketPath
  });
  try {
    assert.equal(await waitForSocket(socketPath), true);
    const res = await rpc(socketPath, {
      id: "9",
      op: "sendTapback",
      params: { chatGuid: "c", targetMessageGuid: "m", kind: "like", action: "add" }
    });
    assert.equal(res.ok, false);
    assert.match(res.error.message, /password/i, "auth failure mentions the password");
  } finally {
    proc.kill("SIGTERM");
    bb.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
});

test("bridge rejects an unknown tapback kind without calling BlueBubbles", async () => {
  const socketPath = tmpSocket("kind");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const bb = await startFakeBlueBubbles(() => ({ body: { status: 200, data: null } }));
  const { proc } = startBridge({
    BLUEBUBBLES_SERVER_URL: bb.url,
    BLUEBUBBLES_PASSWORD: "x",
    IMESSAGE_PRIVATE_API_SOCKET: socketPath
  });
  try {
    assert.equal(await waitForSocket(socketPath), true);
    const res = await rpc(socketPath, {
      id: "10",
      op: "sendTapback",
      params: { chatGuid: "c", targetMessageGuid: "m", kind: "sparkles", action: "add" }
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "unsupported_kind");
    assert.equal(
      bb.received.some((r) => r.path === "/api/v1/message/react"),
      false,
      "must not hit BlueBubbles for an unknown kind"
    );
  } finally {
    proc.kill("SIGTERM");
    bb.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
});
