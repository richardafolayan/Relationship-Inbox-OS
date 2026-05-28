#!/usr/bin/env node
/**
 * Mock iMessage private-API helper (#273) — DEV / TEST ONLY.
 *
 * Stands in for the real external Swift bundle that injects into Messages.app
 * (which requires disabling SIP). This mock speaks the exact same NDJSON
 * protocol over the same UNIX socket, so you can exercise the runner's
 * native-send routing end-to-end — threaded replies and tapbacks flipping to
 * deliveredNative=true, the dashboard tapback trigger, the fallback when it's
 * down — WITHOUT weakening macOS security. It does not actually touch
 * Messages.app; it just logs what it was asked to send and acknowledges.
 *
 * It is intentionally dependency-free plain Node (no build step) and is never
 * wired into the production runner. See docs/imessage-private-api.md.
 *
 * Usage:
 *   node tools/mock-imessage-helper/server.mjs
 *   npm run mock:imessage-helper
 *
 * Then start the runner with:
 *   IMESSAGE_PRIVATE_API_ENABLED=true \
 *   IMESSAGE_PRIVATE_API_SOCKET=<printed path> \
 *   npm run dev
 *
 * Env:
 *   IMESSAGE_PRIVATE_API_SOCKET   socket path to listen on (default:
 *                                 ~/.relationship-inbox/imessage-helper.sock)
 *   MOCK_UNSUPPORTED_KINDS        comma-separated tapback kinds to reject with
 *                                 `unsupported_kind` (to test the iOS 18+
 *                                 expanded-emoji degrade path), e.g. "question"
 *   MOCK_FAIL_REPLIES=true        make every threaded reply fail (test fallback)
 */
import net from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SUPPORTED_KINDS = ["heart", "like", "dislike", "laugh", "emphasize", "question"];

const socketPath =
  process.env.IMESSAGE_PRIVATE_API_SOCKET?.trim() ||
  resolve(homedir(), ".relationship-inbox", "imessage-helper.sock");

const unsupportedKinds = new Set(
  (process.env.MOCK_UNSUPPORTED_KINDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const failReplies = (process.env.MOCK_FAIL_REPLIES ?? "").trim().toLowerCase() === "true";

function log(...args) {
  console.log("[mock-imessage-helper]", ...args);
}

function handleRequest(req) {
  const id = typeof req?.id === "string" ? req.id : null;
  if (!id) {
    return { id: "?", ok: false, error: { code: "invalid_params", message: "missing string id" } };
  }
  const { op, params } = req;
  switch (op) {
    case "ping":
      return {
        id,
        ok: true,
        result: {
          helper: "mock-imessage-helper",
          protocol: 1,
          capabilities: {
            tapbackKinds: SUPPORTED_KINDS.filter((k) => !unsupportedKinds.has(k)),
            threadedReply: !failReplies
          }
        }
      };

    case "sendThreadedReply": {
      if (!params?.chatGuid || !params?.parentMessageGuid || typeof params?.text !== "string") {
        return { id, ok: false, error: { code: "invalid_params", message: "chatGuid, parentMessageGuid, text required" } };
      }
      if (failReplies) {
        log(`threaded reply FAILED (MOCK_FAIL_REPLIES) chat=${params.chatGuid}`);
        return { id, ok: false, error: { code: "send_failed", message: "simulated reply failure" } };
      }
      const messageGuid = `mock-${randomUUID()}`;
      log(
        `threaded reply  chat=${params.chatGuid} parent=${params.parentMessageGuid} ` +
          `text=${JSON.stringify(String(params.text).slice(0, 60))} -> ${messageGuid}`
      );
      return { id, ok: true, result: { messageGuid } };
    }

    case "sendTapback": {
      if (!params?.chatGuid || !params?.targetMessageGuid || !params?.kind) {
        return { id, ok: false, error: { code: "invalid_params", message: "chatGuid, targetMessageGuid, kind required" } };
      }
      if (!SUPPORTED_KINDS.includes(params.kind) || unsupportedKinds.has(params.kind)) {
        log(`tapback UNSUPPORTED kind=${params.kind}`);
        return { id, ok: false, error: { code: "unsupported_kind", message: `kind '${params.kind}' not supported on this build` } };
      }
      log(
        `tapback ${params.action ?? "add"} ${params.kind}  ` +
          `chat=${params.chatGuid} target=${params.targetMessageGuid}`
      );
      return { id, ok: true, result: {} };
    }

    default:
      return { id, ok: false, error: { code: "unsupported_op", message: `unknown op '${op}'` } };
  }
}

mkdirSync(dirname(socketPath), { recursive: true });
// Clear a stale socket left by a previous run (otherwise listen() EADDRINUSE).
if (existsSync(socketPath)) {
  try {
    unlinkSync(socketPath);
  } catch {
    // best effort
  }
}

const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let response;
      try {
        response = handleRequest(JSON.parse(line));
      } catch {
        response = { id: "?", ok: false, error: { code: "invalid_params", message: "malformed JSON request" } };
      }
      socket.write(`${JSON.stringify(response)}\n`);
    }
  });
  // Clients open a short-lived connection per request; ignore their resets.
  socket.on("error", () => {});
});

server.on("error", (error) => {
  console.error("[mock-imessage-helper] server error:", error.message);
  process.exit(1);
});

server.listen(socketPath, () => {
  log(`listening on ${socketPath}`);
  if (unsupportedKinds.size) log(`simulating unsupported tapback kinds: ${[...unsupportedKinds].join(", ")}`);
  if (failReplies) log("simulating threaded-reply failures (MOCK_FAIL_REPLIES=true)");
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
