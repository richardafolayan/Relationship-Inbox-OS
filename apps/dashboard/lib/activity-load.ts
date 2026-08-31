export interface ActivityLoadState<Row> {
  rows: Row[] | null;
  pending: boolean;
  error: string | null;
}

export interface ActivityReceiptPresentation {
  count: number | null;
  drawerAvailable: boolean;
}

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
