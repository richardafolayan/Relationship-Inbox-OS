import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  shouldDiscardStagedAttachments,
  type StagedAttachmentOwnership
} from "./staged-attachment-cleanup";

export function multipartOnly(upload: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (contentType.startsWith("multipart/form-data")) {
      upload(req, res, next);
      return;
    }
    next();
  };
}

export function createStagedAttachmentRequestLifecycle(
  req: Request,
  deps: {
    discard: (attachments: Array<{ absolutePath: string }>) => Promise<void>;
    resolveOwnership: (
      clientSendId: string | undefined,
      attachments: Array<{ absolutePath: string }>
    ) => Promise<StagedAttachmentOwnership>;
  }
): {
  markHandled: () => void;
  markPersistenceAttempted: (clientSendId: string | undefined) => void;
  finalize: () => Promise<void>;
} {
  const uploadedAttachmentPaths = (
    (req.files as Express.Multer.File[] | undefined) ?? []
  ).map((file) => ({ absolutePath: file.path }));
  let clientSendId: string | undefined;
  let handled = false;
  let persistenceAttempted = false;

  return {
    markHandled: () => {
      handled = true;
    },
    markPersistenceAttempted: (nextClientSendId) => {
      clientSendId = nextClientSendId;
      persistenceAttempted = true;
    },
    finalize: async () => {
      if (handled) return;
      const ownership: StagedAttachmentOwnership = persistenceAttempted
        ? await deps
            .resolveOwnership(clientSendId, uploadedAttachmentPaths)
            .catch(() => "unknown")
        : "unowned";
      if (
        shouldDiscardStagedAttachments({
          handled,
          ownership,
          persistenceAttempted
        })
      ) {
        await deps.discard(uploadedAttachmentPaths).catch(() => undefined);
      }
    }
  };
}
