export interface RevisionedSetupPreferences {
  revision: number;
}

type SetupPreferencePayload<TPartial extends object> = TPartial & {
  expectedRevision: number;
};

export interface SetupPreferenceWriteResult<TPreferences> {
  preferences: TPreferences;
  applied: boolean;
}

interface CompletedSetupPersistence<TPreferences> {
  completedAt: string;
  persistCompletion(completedAt: string): Promise<TPreferences>;
  markComplete(): void;
}

export async function persistCompletedSetup<TPreferences>(
  persistence: CompletedSetupPersistence<TPreferences>
): Promise<TPreferences> {
  const preferences = await persistence.persistCompletion(persistence.completedAt);
  persistence.markComplete();
  return preferences;
}

function validRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function createSetupPreferenceWriteQueue<
  TPreferences extends RevisionedSetupPreferences,
  TPartial extends object
>(
  initialRevision: number,
  persist: (payload: SetupPreferencePayload<TPartial>) => Promise<TPreferences>
) {
  let revision = validRevision(initialRevision) ? initialRevision : 0;
  let tail: Promise<void> = Promise.resolve();

  function acceptSnapshot(snapshot: Pick<TPreferences, "revision">): boolean {
    if (!validRevision(snapshot.revision) || snapshot.revision < revision) {
      return false;
    }
    revision = snapshot.revision;
    return true;
  }

  function save(partial: TPartial): Promise<SetupPreferenceWriteResult<TPreferences>> {
    const run = tail.then(async () => {
      const preferences = await persist({
        ...partial,
        expectedRevision: revision
      });
      return {
        preferences,
        applied: acceptSnapshot(preferences)
      };
    });
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    save,
    acceptSnapshot,
    latestRevision: () => revision
  };
}
