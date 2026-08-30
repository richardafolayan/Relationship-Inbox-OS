import type { NextFunction, Request, Response } from "express";

type RegisteredUserTriggeredIntent = {
  operationStarted: boolean;
  release: () => void;
  intentVersion?: number;
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
    /^\/control\/(operator-profile|settings|setup\/preferences)\/?$/i.test(req.path)
    ? "focus-policy"
    : undefined;
}

export function beginUserTriggeredIntentOperation(res: Response): () => void {
  const intent = registeredIntents.get(res);
  if (!intent) return () => {};
  intent.operationStarted = true;
  return intent.release;
}

export function userTriggeredIntentVersion(res: Response): number | undefined {
  return registeredIntents.get(res)?.intentVersion;
}

export function abandonUnstartedUserTriggeredIntent(res: Response): void {
  const intent = registeredIntents.get(res);
  if (intent && !intent.operationStarted) intent.release();
}

export function createUserTriggeredIntentMiddleware(
  register: (threadId: string) =>
    | (() => void)
    | {
        release: () => void;
        ready: Promise<number | undefined>;
      },
  resolveThreadId: (req: Request) => string | undefined = (req) =>
    typeof req.params.threadId === "string" ? req.params.threadId : undefined
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const threadId = resolveThreadId(req);
    if (!threadId) {
      next();
      return;
    }
    const registration = register(threadId);
    const release =
      typeof registration === "function" ? registration : registration.release;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      registeredIntents.delete(res);
      release();
    };
    const intent: RegisteredUserTriggeredIntent = {
      operationStarted: false,
      release: releaseOnce
    };
    registeredIntents.set(res, intent);
    const continueRequest = () => {
      try {
        next();
      } catch (error) {
        releaseOnce();
        throw error;
      }
    };
    if (typeof registration === "function") {
      continueRequest();
      return;
    }
    void registration.ready.then(
      (intentVersion) => {
        intent.intentVersion = intentVersion;
        continueRequest();
      },
      (error) => {
        releaseOnce();
        next(error);
      }
    );
  };
}
