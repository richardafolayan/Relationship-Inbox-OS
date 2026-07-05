// Pilot R-0093 (#760): inbox/Today previews showed the bare "[Voice note]"
// placeholder for audio-only messages even after the voice note had been
// transcribed. Transcription is asynchronous — the scan persists the thread
// (and its lastMessagePreview) before any transcript exists, and nothing
// wrote the finished transcript back. This module is that write-back: when a
// transcript is selected for a message that is still the thread's newest
// message and whose text is a contentless voice placeholder, the transcript
// becomes the thread preview.
import type { PrismaClient } from "@prisma/client";
import { cleanText } from "../platforms/utils";

// Matches the audio-flavoured outputs of describeAttachments() in
// imessage-db.ts ("[Voice note]", "[2 Voice notes]", "[Voice note, Photo]",
// "[Audio]") plus the LinkedIn adapter's "[voice message]" body and the
// list-derived "You sent a voice message" preview. Deliberately NOT matching
// captioned messages — those have real text and keep it as the preview.
const BRACKET_VOICE_RE = /^\[[^\]]*(voice note|voice message|audio)[^\]]*\]$/i;
const SENT_VOICE_RE = /^(you(:| sent))?\s*(sent )?a? ?voice (message|note)[.!]?$/i;

export function isVoicePlaceholderText(raw: string | null | undefined): boolean {
  const text = (raw ?? "").trim();
  if (!text) return false;
  return BRACKET_VOICE_RE.test(text) || SENT_VOICE_RE.test(text);
}

/**
 * The preview string a finished transcript should produce. Collapses
 * whitespace the same way scan previews do; no truncation — the dashboard
 * already ellipsizes visually and Today rows are allowed to wrap in full.
 */
export function previewFromTranscript(transcript: string): string {
  return cleanText(transcript);
}

export interface PropagateResult {
  updated: boolean;
  threadId?: string;
}

// Narrow structural interface so tests can pass a plain fake instead of a
// real PrismaClient.
export interface TranscriptPreviewDb {
  messageAudioTranscription: {
    findUnique(args: {
      where: { messageId: string };
      select: { status: true; transcript: true };
    }): Promise<{ status: string; transcript: string | null } | null>;
  };
  message: {
    findUnique(args: {
      where: { id: string };
      select: { threadId: true; timestamp: true; text: true };
    }): Promise<{ threadId: string; timestamp: Date; text: string } | null>;
  };
  thread: {
    findUnique(args: {
      where: { id: string };
      select: { lastMessageAt: true };
    }): Promise<{ lastMessageAt: Date | null } | null>;
    update(args: {
      where: { id: string };
      data: { lastMessagePreview: string };
    }): Promise<unknown>;
  };
}

/**
 * Write a freshly-selected transcript through to Thread.lastMessagePreview.
 *
 * Guards, in order:
 *  - the message must have a successful transcript;
 *  - its own text must be a contentless voice placeholder (captioned voice
 *    notes keep their caption as the preview);
 *  - it must still be the thread's newest message (a newer message owns the
 *    preview now; the transcript would be stale).
 *
 * Intentionally NOT conditioned on the current preview value: tier upgrades
 * (fast → standard → refinement) re-run this and each better transcript
 * simply overwrites the previous one.
 */
export async function propagateTranscriptToThreadPreview(
  db: TranscriptPreviewDb | PrismaClient,
  messageId: string
): Promise<PropagateResult> {
  const prisma = db as TranscriptPreviewDb;
  const transcription = await prisma.messageAudioTranscription.findUnique({
    where: { messageId },
    select: { status: true, transcript: true }
  });
  const transcript = transcription?.transcript?.trim() ?? "";
  if (transcription?.status !== "transcribed" || transcript.length === 0) {
    return { updated: false };
  }
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { threadId: true, timestamp: true, text: true }
  });
  if (!message || !isVoicePlaceholderText(message.text)) return { updated: false };
  const thread = await prisma.thread.findUnique({
    where: { id: message.threadId },
    select: { lastMessageAt: true }
  });
  if (!thread) return { updated: false };
  if (thread.lastMessageAt && message.timestamp.getTime() < thread.lastMessageAt.getTime()) {
    return { updated: false };
  }
  await prisma.thread.update({
    where: { id: message.threadId },
    data: { lastMessagePreview: previewFromTranscript(transcript) }
  });
  return { updated: true, threadId: message.threadId };
}
