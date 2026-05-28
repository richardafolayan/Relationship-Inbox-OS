import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PrivateApiError,
  decodeResponse,
  encodeRequest,
  type OpParams,
  type OpResult,
  type PrivateApiOp,
  type PrivateApiResponse
} from "./protocol";

/**
 * Low-level transport to the injected helper bundle.
 *
 * One short-lived UNIX-socket connection per request: connect → write one
 * NDJSON request line → read until the first newline → parse the response →
 * close. This keeps the bridge stateless and resilient to the helper
 * restarting (e.g. after a Messages.app relaunch) — there is no long-lived
 * connection to go stale, reconnect, or multiplex.
 *
 * Every failure surfaces as a PrivateApiError so the routing layer can make
 * a single, uniform "native failed → fall back" decision. Transport-level
 * problems (socket missing, refused, timed out, malformed reply) use the
 * synthetic `"transport"` code; helper-reported problems carry the helper's
 * own structured code (e.g. `unsupported_kind`).
 */
export interface HelperBridgeOptions {
  socketPath: string;
  /** Per-request timeout in ms (connect + round-trip). */
  timeoutMs: number;
}

export async function sendHelperRequest<Op extends PrivateApiOp>(
  options: HelperBridgeOptions,
  op: Op,
  params: OpParams[Op]
): Promise<OpResult[Op]> {
  const id = randomUUID();
  const response = await roundTrip(options, { id, op, params });

  if (response.id !== id) {
    throw new PrivateApiError(
      "transport",
      `helper replied to id ${response.id}, expected ${id}`
    );
  }
  if (response.ok) {
    return response.result as OpResult[Op];
  }
  throw new PrivateApiError(response.error.code, response.error.message);
}

function roundTrip<Op extends PrivateApiOp>(
  options: HelperBridgeOptions,
  request: { id: string; op: Op; params: OpParams[Op] }
): Promise<PrivateApiResponse<Op>> {
  return new Promise<PrivateApiResponse<Op>>((resolve, reject) => {
    const socket = connect(options.socketPath);
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new PrivateApiError(
            "transport",
            `helper request "${request.op}" timed out after ${options.timeoutMs}ms`
          )
        )
      );
    }, options.timeoutMs);
    // Don't let a pending helper probe keep the process alive on shutdown.
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(encodeRequest(request));
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return; // wait for the rest of the line
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        const decoded = decodeResponse(line) as PrivateApiResponse<Op>;
        finish(() => resolve(decoded));
      } catch (error) {
        finish(() =>
          reject(new PrivateApiError("transport", (error as Error).message))
        );
      }
    });

    socket.on("error", (error) => {
      finish(() =>
        reject(
          new PrivateApiError(
            "transport",
            `helper socket error: ${(error as Error).message}`
          )
        )
      );
    });

    socket.on("end", () => {
      finish(() =>
        reject(
          new PrivateApiError(
            "transport",
            "helper closed the connection before replying"
          )
        )
      );
    });
  });
}
