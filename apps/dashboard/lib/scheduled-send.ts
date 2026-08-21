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
        text: input.text,
        clientSendId: input.clientSendId,
        scheduledFor: input.scheduledFor,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
      }
    };
  }

  const body = new FormData();
  body.append("text", input.text);
  body.append("clientSendId", input.clientSendId);
  body.append("scheduledFor", input.scheduledFor);
  if (input.replyToMessageId) body.append("replyToMessageId", input.replyToMessageId);
  for (const attachment of input.attachments) {
    body.append("attachments", attachment.file, attachment.file.name);
  }
  return { kind: "multipart", body };
}
