import { rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface StagedAttachment {
  absolutePath: string;
}

export async function cleanupStagedAttachments(
  attachments: readonly StagedAttachment[]
): Promise<void> {
  const directories = new Set<string>();
  for (const attachment of attachments) {
    const absolutePath = resolve(attachment.absolutePath);
    const marker = `${sep}outgoing-attachments${sep}`;
    const markerIndex = absolutePath.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const relative = absolutePath.slice(markerIndex + marker.length);
    const directoryName = relative.split(sep, 1)[0] ?? "";
    if (!/^[0-9a-f-]{20,}$/i.test(directoryName)) continue;
    const directory = dirname(absolutePath);
    if (directory.endsWith(`${sep}${directoryName}`)) directories.add(directory);
  }
  await Promise.all(
    [...directories].map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => undefined)
    )
  );
}
