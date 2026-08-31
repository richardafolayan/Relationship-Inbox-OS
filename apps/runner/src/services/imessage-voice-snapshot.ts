interface VoiceAttachmentMetadata {
  absolutePath: string | null;
  mimeType: string | null;
  filename: string | null;
  transferName: string | null;
}

interface VoiceSnapshotDatabase {
  findAttachmentByGuid(guid: string): VoiceAttachmentMetadata | null | undefined;
  close(): void;
}

interface IMessageVoiceSnapshotDeps {
  enabled(): boolean;
  loadAttachmentsJson(messageId: string): Promise<string | null>;
  openDatabase(): VoiceSnapshotDatabase;
  existingSnapshotPath(guid: string): string | null;
  snapshot(guid: string, sourcePath: string): void;
  enqueue(messageId: string, shouldContinue: () => boolean): void;
}

function isVoiceNoteAttachment(meta: VoiceAttachmentMetadata): boolean {
  const mime = (meta.mimeType ?? "").toLowerCase();
  if (mime.includes("audio") || mime.includes("caf") || mime.includes("coreaudio")) return true;
  const name = (meta.transferName ?? meta.filename ?? "").toLowerCase();
  return /\.(caf|m4a|amr|aac|wav|mp3)$/.test(name) || name.includes("audio message");
}

export function createIMessageVoiceSnapshotService(deps: IMessageVoiceSnapshotDeps) {
  async function handle(
    messageId: string,
    isAllowed: () => Promise<boolean>,
    snapshotIMessage = true,
    shouldContinue: () => boolean = () => true
  ): Promise<void> {
    if (!deps.enabled() || !(await isAllowed())) return;

    if (snapshotIMessage) {
      let attachmentsJson: string | null;
      try {
        attachmentsJson = await deps.loadAttachmentsJson(messageId);
      } catch {
        return;
      }
      if (!(await isAllowed()) || !attachmentsJson) return;

      let guids: string[];
      try {
        const parsed = JSON.parse(attachmentsJson) as Array<{ guid?: string | null }>;
        guids = parsed
          .map((attachment) => attachment?.guid)
          .filter((guid): guid is string => typeof guid === "string" && guid.length > 0);
      } catch {
        return;
      }
      if (guids.length === 0 || !(await isAllowed())) return;

      let database: VoiceSnapshotDatabase;
      try {
        database = deps.openDatabase();
      } catch {
        return;
      }
      try {
        for (const guid of guids) {
          if (!(await isAllowed())) return;
          if (deps.existingSnapshotPath(guid)) continue;
          const metadata = database.findAttachmentByGuid(guid);
          if (!metadata?.absolutePath || !isVoiceNoteAttachment(metadata)) continue;
          if (!(await isAllowed())) return;
          deps.snapshot(guid, metadata.absolutePath);
        }
      } catch {
        return;
      } finally {
        database.close();
      }
    }

    if (!(await isAllowed())) return;
    if (!shouldContinue()) return;
    deps.enqueue(messageId, shouldContinue);
  }

  return { handle };
}
