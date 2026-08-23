export function applyRecoverableSchemaChange({ backup, repair, sync, restore }) {
  const backupResult = backup();
  if (!backupResult.ok) return false;
  if (!repair()) return false;
  if (sync()) return true;
  restore(backupResult.backupPath);
  return false;
}
