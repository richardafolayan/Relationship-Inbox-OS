export function applyRecoverableSchemaChange({ backup, repair, sync, restore }) {
  const backupResult = backup();
  if (!backupResult.ok) return false;
  let completed = false;
  try {
    if (!repair()) return false;
    completed = sync();
    return completed;
  } finally {
    if (!completed) restore(backupResult.backupPath);
  }
}
