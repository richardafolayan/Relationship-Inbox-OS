export interface DraftRevisionInput {
  text: string;
  updatedAt: string;
}

export interface DraftDeleteClient {
  draft: {
    deleteMany(input: {
      where: { threadId: string; text: string; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export async function deleteDraftRevision(
  prisma: DraftDeleteClient,
  threadId: string,
  revision: DraftRevisionInput
): Promise<boolean> {
  const deletion = await prisma.draft.deleteMany({
    where: {
      threadId,
      text: revision.text,
      updatedAt: new Date(revision.updatedAt)
    }
  });
  return deletion.count === 1;
}
