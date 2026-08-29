import type { NextFunction, Request, Response } from "express";

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
      release();
    };
    res.once("finish", releaseOnce);
    res.once("close", releaseOnce);
    try {
      next();
    } catch (error) {
      releaseOnce();
      throw error;
    }
  };
}
