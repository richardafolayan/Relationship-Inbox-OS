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
  try {
    persistence.markComplete();
  } catch {
    // Server completion is authoritative. The local marker is only a cache.
  }
  return preferences;
}

export function completedPreferencesFromConflict<
  TPreferences extends { completedAt: string }
>(status: number, payload: unknown): TPreferences | null {
  if (status !== 409 || !payload || typeof payload !== "object") return null;
  const preferences = (payload as { preferences?: TPreferences }).preferences;
  return preferences?.completedAt ? preferences : null;
}

export function setupNavigationDisabled(
  busy: boolean,
  phase: "idle" | "downloading" | "error" | undefined
): boolean {
  return busy || phase === "downloading";
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
