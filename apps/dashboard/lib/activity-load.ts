export interface ActivityLoadState<Row> {
  rows: Row[] | null;
  pending: boolean;
  error: string | null;
}

export interface ActivityReceiptPresentation {
  count: number | null;
  drawerAvailable: boolean;
}

export interface ActivityLoader<Row> {
  refresh(loadRows: () => Promise<Row[]>): Promise<void>;
  invalidate(): void;
}

type ActivityStateUpdater<Row> = (
  update: (state: ActivityLoadState<Row>) => ActivityLoadState<Row>
) => void;

export function activityReceiptPresentation<Row>(
  state: ActivityLoadState<Row>
): ActivityReceiptPresentation {
  return state.rows === null
    ? { count: null, drawerAvailable: false }
    : { count: state.rows.length, drawerAvailable: true };
}

export function initialActivityLoadState<Row>(): ActivityLoadState<Row> {
  return { rows: null, pending: false, error: null };
}

export function beginActivityLoad<Row>(
  state: ActivityLoadState<Row>
): ActivityLoadState<Row> {
  return { ...state, pending: true };
}

export function finishActivityLoad<Row>(
  _state: ActivityLoadState<Row>,
  rows: Row[]
): ActivityLoadState<Row> {
  return { rows, pending: false, error: null };
}

export function failActivityLoad<Row>(
  state: ActivityLoadState<Row>,
  error: string
): ActivityLoadState<Row> {
  return { rows: state.rows, pending: false, error };
}

export function createLatestActivityLoader<Row>(
  updateState: ActivityStateUpdater<Row>
): ActivityLoader<Row> {
  let latestRequest = 0;

  return {
    async refresh(loadRows) {
      const request = ++latestRequest;
      updateState((state) => beginActivityLoad(state));
      try {
        const rows = await loadRows();
        if (request !== latestRequest) return;
        updateState((state) => finishActivityLoad(state, rows));
      } catch (error) {
        if (request !== latestRequest) return;
        updateState((state) =>
          failActivityLoad(
            state,
            error instanceof Error && error.message
              ? error.message
              : "Failed to load activity"
          )
        );
      }
    },
    invalidate() {
      latestRequest += 1;
    }
  };
}
