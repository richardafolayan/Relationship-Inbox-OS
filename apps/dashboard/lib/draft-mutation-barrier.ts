import type { SavedDraftRevision } from "./saved-draft-revision";

type DraftRevision = SavedDraftRevision | null;

type ThreadDraftState = {
  clearedAt: number | null;
  generation: number;
  hasLatest: boolean;
  latest: DraftRevision;
  tail: Promise<void>;
  uncertain: boolean;
};

export class DraftMutationUncertainError extends Error {
  constructor() {
    super("Tovi could not confirm the last draft change. Reload before sending or scheduling.");
    this.name = "DraftMutationUncertainError";
  }
}

function sameRevision(left: DraftRevision, right: DraftRevision): boolean {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        left.text === right.text &&
        left.updatedAt === right.updatedAt
    )
  );
}

export function createDraftMutationBarrier() {
  const states = new Map<string, ThreadDraftState>();

  function stateFor(threadId: string): ThreadDraftState {
    const existing = states.get(threadId);
    if (existing) return existing;
    const created: ThreadDraftState = {
      clearedAt: null,
      generation: 0,
      hasLatest: false,
      latest: null,
      tail: Promise.resolve(),
      uncertain: false
    };
    states.set(threadId, created);
    return created;
  }

  function settle<T>(
    state: ThreadDraftState,
    operation: Promise<T>,
    onSuccess: (value: T) => void
  ): Promise<T> {
    state.tail = operation.then(
      (value) => {
        onSuccess(value);
        state.generation += 1;
        state.uncertain = false;
      },
      () => {
        state.uncertain = true;
      }
    );
    return operation;
  }

  function enqueueSave(
    threadId: string,
    save: () => Promise<SavedDraftRevision>
  ): Promise<SavedDraftRevision> {
    const state = stateFor(threadId);
    const operation = state.tail.then(save);
    return settle(state, operation, (revision) => {
      state.clearedAt = null;
      state.hasLatest = true;
      state.latest = revision;
    });
  }

  function enqueueDelete<T extends { deleted: boolean }>(
    threadId: string,
    fallback: DraftRevision,
    remove: (revision: SavedDraftRevision) => Promise<T>
  ): Promise<{ deletedRevision: DraftRevision; result: T }> {
    const state = stateFor(threadId);
    const operation = state.tail.then(async () => {
      const deletedRevision = state.hasLatest ? state.latest : fallback;
      const result = deletedRevision
        ? await remove(deletedRevision)
        : ({ deleted: false } as T);
      return { deletedRevision, result };
    });
    return settle(state, operation, ({ deletedRevision, result }) => {
      if (result.deleted) {
        state.clearedAt = deletedRevision ? Date.parse(deletedRevision.updatedAt) : 0;
        state.hasLatest = true;
        state.latest = null;
      } else {
        state.clearedAt = null;
        state.hasLatest = false;
        state.latest = null;
      }
    });
  }

  async function waitForRevision(
    threadId: string,
    fallback: DraftRevision
  ): Promise<DraftRevision> {
    const state = stateFor(threadId);
    await state.tail;
    if (state.uncertain) throw new DraftMutationUncertainError();
    if (!state.hasLatest) {
      state.hasLatest = true;
      state.latest = fallback;
    }
    return state.latest;
  }

  function generation(threadId: string): number {
    return stateFor(threadId).generation;
  }

  function reconcileFetchedRevision(
    threadId: string,
    requestGeneration: number,
    fetched: DraftRevision
  ): DraftRevision {
    const state = stateFor(threadId);
    if (
      state.hasLatest &&
      state.latest &&
      fetched &&
      (Date.parse(fetched.updatedAt) < Date.parse(state.latest.updatedAt) ||
        (fetched.updatedAt === state.latest.updatedAt && fetched.text === state.latest.text))
    ) {
      return state.latest;
    }
    if (
      state.hasLatest &&
      state.latest === null &&
      state.clearedAt !== null &&
      fetched &&
      Date.parse(fetched.updatedAt) <= state.clearedAt
    ) {
      return null;
    }
    const fetchedIsNewerThanLatest = Boolean(
      fetched &&
        ((state.latest &&
          Date.parse(fetched.updatedAt) > Date.parse(state.latest.updatedAt)) ||
          (state.latest === null &&
            state.clearedAt !== null &&
            Date.parse(fetched.updatedAt) > state.clearedAt))
    );
    if (
      state.generation !== requestGeneration &&
      state.hasLatest &&
      !fetchedIsNewerThanLatest
    ) {
      return state.latest;
    }
    if (!state.uncertain) {
      state.clearedAt = null;
      state.hasLatest = true;
      state.latest = fetched;
    }
    return state.hasLatest ? state.latest : fetched;
  }

  function consumeRevision(threadId: string, expected: DraftRevision): boolean {
    if (!expected) return false;
    const state = stateFor(threadId);
    if (!state.hasLatest || !sameRevision(state.latest, expected)) return false;
    state.clearedAt = Date.parse(expected.updatedAt);
    state.hasLatest = true;
    state.latest = null;
    state.generation += 1;
    state.uncertain = false;
    return true;
  }

  return {
    consumeRevision,
    enqueueDelete,
    enqueueSave,
    generation,
    reconcileFetchedRevision,
    waitForRevision
  };
}
