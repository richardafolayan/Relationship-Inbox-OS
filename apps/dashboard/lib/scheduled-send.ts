export interface ScheduledSendAttachment {
  file: File;
}

export type ScheduledSendRequest =
  | { kind: "json"; body: Record<string, string> }
  | { kind: "multipart"; body: FormData };

export function buildScheduledSendRequest(input: {
  attachments: ScheduledSendAttachment[];
  clientSendId: string;
  replyToMessageId?: string;
  scheduledFor: string;
  text: string;
}): ScheduledSendRequest {
  if (input.attachments.length === 0) {
    return {
      kind: "json",
      body: {
        clientSendId: input.clientSendId,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        scheduledFor: input.scheduledFor,
        text: input.text
      }
    };
  }

  const body = new FormData();
  body.append("clientSendId", input.clientSendId);
  if (input.replyToMessageId) body.append("replyToMessageId", input.replyToMessageId);
  body.append("scheduledFor", input.scheduledFor);
  body.append("text", input.text);
  for (const attachment of input.attachments) {
    body.append("attachments", attachment.file, attachment.file.name);
  }
  return { kind: "multipart", body };
}
