import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

const retryAttachmentSchema = z.object({
  absolutePath: z.string().min(1),
  displayName: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  kind: z.string().min(1).optional()
});

export type RetryAttachment = z.infer<typeof retryAttachmentSchema>;

export function deriveRetryClientSendId(originalClientSendId: string): string {
  return uuidv5("retry", originalClientSendId);
}

export function parseRetryAttachments(
  attachmentsJson: string | null | undefined
): RetryAttachment[] | undefined {
  if (!attachmentsJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    throw new Error("Stored attachment metadata is invalid; retry was blocked");
  }
  const result = z.array(retryAttachmentSchema).min(1).safeParse(parsed);
  if (!result.success) {
    throw new Error("Stored attachment metadata is invalid; retry was blocked");
  }
  return result.data;
}
