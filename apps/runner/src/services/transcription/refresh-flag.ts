/**
 * `needsAiRefresh` clear-targeting for the resummarise path (issue #385).
 *
 * The progressive transcription pipeline sets
 * `MessageAudioTranscription.needsAiRefresh = true` whenever a
 * higher-tier transcript (or a refinement pass) replaces an earlier
 * selection AFTER a thread has already been summarised — a signal that
 * the stored brief may be stale because the underlying audio text moved
 * on. PR #384 set the flag but nothing ever cleared it.
 *
 * When `resummarizeThreadById` writes a fresh summary it has just
 * consumed those messages' current transcripts, so the brief is caught
 * up. This pure helper picks out exactly which of the consumed messages
 * still carry the flag, so the caller can clear it in the same
 * transaction as the summary write. Extracted as a pure function so the
 * selection rule is unit-testable without prisma or Express.
 */

export interface MessageWithTranscriptionRefreshFlag {
  id: string;
  audioTranscription: { needsAiRefresh: boolean } | null;
}

/**
 * Return the IDs of the messages whose audio transcription is flagged
 * `needsAiRefresh`. Messages with no transcription, or whose flag is
 * already clear, are skipped so the caller only writes rows that change.
 */
export function messageIdsAwaitingTranscriptRefresh(
  messages: MessageWithTranscriptionRefreshFlag[]
): string[] {
  return messages
    .filter((m) => m.audioTranscription?.needsAiRefresh === true)
    .map((m) => m.id);
}
