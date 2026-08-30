export async function runConfirmedTodayAction({
  request,
  onConfirmed,
  onFailure
}: {
  request: () => Promise<unknown>;
  onConfirmed: () => void;
  onFailure: (message: string) => void;
}): Promise<boolean> {
  try {
    await request();
  } catch (error) {
    onFailure(error instanceof Error ? error.message : String(error));
    return false;
  }

  onConfirmed();
  return true;
}
