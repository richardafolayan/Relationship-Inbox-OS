#!/usr/bin/env node
/**
 * BlueBubbles real-helper bridge for #273 — makes native iMessage tapbacks /
 * threaded replies actually appear on the recipient's device.
 *
 * The runner speaks the fixed NDJSON-over-UNIX-socket protocol
 * (apps/runner/src/platforms/imessage-private-api/protocol.ts). The bundled
 * mock helper just logs/acks it. THIS bridge implements the same protocol but
 * forwards each call to a locally-running BlueBubbles Server's Private API
 * (https://bluebubbles.app) over HTTP — BlueBubbles is what actually drives
 * Messages.app's private API, so the contact sees a real native reaction/reply.
 *
 * It is dependency-free plain Node (global fetch, Node >=18). It is NOT wired
 * into the runner or started by default; the mock helper stays the default.
 * Setup (SIP off, install BlueBubbles, enable Private API) is a deliberate,
 * documented, opt-in step — see docs/imessage-real-helper-runbook.md.
 *
 * Usage:
 *   BLUEBUBBLES_SERVER_URL=http://localhost:1234 \
 *   BLUEBUBBLES_PASSWORD=your-server-password \
 *   IMESSAGE_PRIVATE_API_SOCKET="$HOME/.relationship-inbox/imessage-helper.sock" \
 *   node tools/bluebubbles-helper-bridge.mjs
 *
 * Then start the runner with IMESSAGE_PRIVATE_API_ENABLED=true and the same
 * IMESSAGE_PRIVATE_API_SOCKET.
 *
 * Env:
 *   BLUEBUBBLES_SERVER_URL        BlueBubbles server base URL (default http://localhost:1234)
 *   BLUEBUBBLES_PASSWORD          BlueBubbles server password (required)
 *   IMESSAGE_PRIVATE_API_SOCKET   socket to listen on (default ~/.relationship-inbox/imessage-helper.sock)
 *   BLUEBUBBLES_REQUEST_TIMEOUT_MS per-HTTP-call timeout (default 8000)
 */
import net from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;
const SUPPORTED_KINDS = ["heart", "like", "dislike", "laugh", "emphasize", "question"];

// Our protocol's tapback kinds → BlueBubbles reaction names. BlueBubbles
// removes a reaction by sending the same name prefixed with "-".
const BB_REACTION = {
  heart: "love",
  like: "like",
  dislike: "dislike",
  laugh: "laugh",
  emphasize: "emphasize",
  question: "question"
};

const serverUrl = (process.env.BLUEBUBBLES_SERVER_URL?.trim() || "http://localhost:1234").replace(/\/+$/, "");
const password = process.env.BLUEBUBBLES_PASSWORD ?? "";
const requestTimeoutMs = Number(process.env.BLUEBUBBLES_REQUEST_TIMEOUT_MS ?? 8000) || 8000;
const socketPath =
  process.env.IMESSAGE_PRIVATE_API_SOCKET?.trim() ||
  resolve(homedir(), ".relationship-inbox", "imessage-helper.sock");

function log(...args) {
  console.log("[bluebubbles-bridge]", ...args);
}

/** Call the BlueBubbles REST API. Resolves the parsed `data`, throws a tagged Error otherwise. */
async function bbCall(method, path, body) {
  const url = `${serverUrl}${path}?password=${encodeURIComponent(password)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    const e = new Error(`BlueBubbles unreachable at ${serverUrl}: ${err?.message ?? err}`);
    e.code = "internal";
    throw e;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // some endpoints may return empty bodies
  }

  if (res.status === 401 || res.status === 403) {
    const e = new Error("BlueBubbles rejected the password (check BLUEBUBBLES_PASSWORD)");
    e.code = "internal";
    throw e;
  }
  if (!res.ok || (payload && typeof payload.status === "number" && payload.status >= 300)) {
    const msg = (payload && (payload.error?.message || payload.message)) || `HTTP ${res.status}`;
    const e = new Error(`BlueBubbles ${path} failed: ${msg}`);
    // A rejected reaction kind is the one error we surface distinctly so the
    // runner degrades that single tapback to dashboard-only instead of erroring.
    e.code = /reaction|tapback|unsupported/i.test(String(msg)) ? "unsupported_kind" : "send_failed";
    throw e;
  }
  return payload?.data ?? null;
}

async function handleRequest(req) {
  const id = typeof req?.id === "string" ? req.id : null;
  if (!id) {
    return { id: "?", ok: false, error: { code: "invalid_params", message: "missing string id" } };
  }
  const { op, params } = req;
  try {
    switch (op) {
      case "ping": {
        await bbCall("GET", "/api/v1/ping");
        return {
          id,
          ok: true,
          result: {
            helper: "bluebubbles-bridge",
            protocol: PROTOCOL_VERSION,
            capabilities: { tapbackKinds: SUPPORTED_KINDS, threadedReply: true }
          }
        };
      }

      case "sendThreadedReply": {
        if (!params?.chatGuid || !params?.parentMessageGuid || typeof params?.text !== "string") {
          return { id, ok: false, error: { code: "invalid_params", message: "chatGuid, parentMessageGuid, text required" } };
        }
        // BlueBubbles Private API send-text with a reply target. `partIndex: 0`
        // replies to the first part of the parent message (text bubbles are a
        // single part).
        const data = await bbCall("POST", "/api/v1/message/text", {
          chatGuid: params.chatGuid,
          tempGuid: randomUUID(),
          message: params.text,
          method: "private-api",
          selectedMessageGuid: params.parentMessageGuid,
          partIndex: 0
        });
        log(`threaded reply -> chat=${params.chatGuid} parent=${params.parentMessageGuid} guid=${data?.guid ?? "?"}`);
        return { id, ok: true, result: { messageGuid: data?.guid } };
      }

      case "sendTapback": {
        if (!params?.chatGuid || !params?.targetMessageGuid || !params?.kind) {
          return { id, ok: false, error: { code: "invalid_params", message: "chatGuid, targetMessageGuid, kind required" } };
        }
        const base = BB_REACTION[params.kind];
        if (!base) {
          return { id, ok: false, error: { code: "unsupported_kind", message: `kind '${params.kind}' not supported` } };
        }
        const action = params.action === "remove" ? "remove" : "add";
        const reaction = action === "remove" ? `-${base}` : base;
        await bbCall("POST", "/api/v1/message/react", {
          chatGuid: params.chatGuid,
          selectedMessageGuid: params.targetMessageGuid,
          reaction,
          partIndex: 0
        });
        log(`tapback ${action} ${params.kind}(${reaction}) -> chat=${params.chatGuid} target=${params.targetMessageGuid}`);
        return { id, ok: true, result: {} };
      }

      default:
        return { id, ok: false, error: { code: "unsupported_op", message: `unknown op '${op}'` } };
    }
  } catch (err) {
    const code = err?.code && typeof err.code === "string" ? err.code : "internal";
    log(`ERROR op=${op} code=${code}: ${err?.message ?? err}`);
    return { id, ok: false, error: { code, message: String(err?.message ?? err) } };
  }
}

mkdirSync(dirname(socketPath), { recursive: true });
if (existsSync(socketPath)) {
  try {
    unlinkSync(socketPath);
  } catch {
    // best effort
  }
}

const server = net.createServer((socket) => {
  let buffer = "";
  // Serialise responses per connection so out-of-order awaits can't interleave.
  let chain = Promise.resolve();
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        let response;
        try {
          response = await handleRequest(JSON.parse(line));
        } catch {
          response = { id: "?", ok: false, error: { code: "invalid_params", message: "malformed JSON request" } };
        }
        socket.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
  socket.on("error", () => {});
});

server.on("error", (error) => {
  console.error("[bluebubbles-bridge] server error:", error.message);
  process.exit(1);
});

server.listen(socketPath, () => {
  log(`listening on ${socketPath}`);
  log(`forwarding to BlueBubbles at ${serverUrl}`);
  if (!password) log("WARNING: BLUEBUBBLES_PASSWORD is empty — set it to your BlueBubbles server password.");
  log("point the runner at it with:");
  log(`  IMESSAGE_PRIVATE_API_ENABLED=true IMESSAGE_PRIVATE_API_SOCKET=${socketPath} npm run dev`);
});

function shutdown() {
  try {
    server.close();
  } catch {
    // ignore
  }
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
