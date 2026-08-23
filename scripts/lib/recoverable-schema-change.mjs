export class SchemaRestoreError extends Error {
  constructor(message, { backupPath = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SchemaRestoreError";
    this.backupPath = backupPath;
  }
}

export function applyRecoverableSchemaChange({ backup, repair, sync, restore }) {
  const backupResult = backup();
  if (!backupResult.ok) return false;
  let completed = false;
  try {
    if (!repair()) return false;
    completed = sync();
    return completed;
  } finally {
    if (!completed) {
      let restored = false;
      try {
        restored = restore(backupResult.backupPath);
      } catch (cause) {
        throw new SchemaRestoreError("The database backup could not be restored", {
          backupPath: backupResult.backupPath,
          cause
        });
      }
      if (!restored) {
        throw new SchemaRestoreError("The database backup could not be restored", {
          backupPath: backupResult.backupPath
        });
      }
    }
  }
}
