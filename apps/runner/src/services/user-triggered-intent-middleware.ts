import type { NextFunction, Request, Response } from "express";

type RegisteredUserTriggeredIntent = {
  operationStarted: boolean;
  release: () => void;
};

const registeredIntents = new WeakMap<Response, RegisteredUserTriggeredIntent>();

type IntentRequest = Pick<Request, "method" | "path">;

export function resolveUserTriggeredIntentThreadId(
  req: IntentRequest
): string | undefined {
  if (req.method.toUpperCase() !== "POST") return undefined;
  const match = req.path.match(
    /^\/control\/thread\/([^/]+)\/(send|send-poll|retry-send)\/?$/i
  );
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

export function resolveFocusPolicyMutationIntentKey(
  req: IntentRequest
): string | undefined {
  return req.method.toUpperCase() === "POST" &&
    /^\/control\/operator-profile\/?$/i.test(req.path)
    ? "focus-policy"
    : undefined;
}

export function beginUserTriggeredIntentOperation(res: Response): () => void {
  const intent = registeredIntents.get(res);
  if (!intent) return () => {};
  intent.operationStarted = true;
  return intent.release;
}

export function abandonUnstartedUserTriggeredIntent(res: Response): void {
  const intent = registeredIntents.get(res);
  if (intent && !intent.operationStarted) intent.release();
}

export function createUserTriggeredIntentMiddleware(
  register: (threadId: string) => () => void,
  resolveThreadId: (req: Request) => string | undefined = (req) =>
    typeof req.params.threadId === "string" ? req.params.threadId : undefined
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const threadId = resolveThreadId(req);
    if (!threadId) {
      next();
      return;
    }
    const release = register(threadId);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      registeredIntents.delete(res);
      release();
    };
    const intent = { operationStarted: false, release: releaseOnce };
    registeredIntents.set(res, intent);
    try {
      next();
    } catch (error) {
      releaseOnce();
      throw error;
    }
  };
}
