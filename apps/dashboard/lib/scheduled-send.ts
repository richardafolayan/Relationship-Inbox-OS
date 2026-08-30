export interface ScheduledSendAttachment {
  file: File;
}

export type ScheduledSendRequest =
  | { kind: "json"; body: Record<string, string> }
  | { kind: "multipart"; body: FormData };

export function buildScheduledSendRequest(input: {
  attachments: ScheduledSendAttachment[];
  clientSendId: string;
  clientRequestedAt?: string;
  draftRevision?: { text: string; updatedAt: string } | null;
  replyToMessageId?: string;
  scheduledFor: string;
  text: string;
}): ScheduledSendRequest {
  if (input.attachments.length === 0) {
    return {
      kind: "json",
      body: {
        clientSendId: input.clientSendId,
        ...(input.clientRequestedAt ? { clientRequestedAt: input.clientRequestedAt } : {}),
        ...(input.draftRevision
          ? {
              consumeDraftText: input.draftRevision.text,
              consumeDraftUpdatedAt: input.draftRevision.updatedAt
            }
          : {}),
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        scheduledFor: input.scheduledFor,
        text: input.text
      }
    };
  }

  const body = new FormData();
  body.append("clientSendId", input.clientSendId);
  if (input.clientRequestedAt) body.append("clientRequestedAt", input.clientRequestedAt);
  if (input.draftRevision) {
    body.append("consumeDraftText", input.draftRevision.text);
    body.append("consumeDraftUpdatedAt", input.draftRevision.updatedAt);
  }
  if (input.replyToMessageId) body.append("replyToMessageId", input.replyToMessageId);
  body.append("scheduledFor", input.scheduledFor);
  body.append("text", input.text);
  for (const attachment of input.attachments) {
    body.append("attachments", attachment.file, attachment.file.name);
  }
  return { kind: "multipart", body };
}
