export class SchemaRestoreError extends Error {
  constructor(message, { backupPath = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SchemaRestoreError";
    this.backupPath = backupPath;
  }
}

export class SchemaChangeRestoredError extends Error {
  constructor(message, { backupPath = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SchemaChangeRestoredError";
    this.backupPath = backupPath;
  }
}

export function applyRecoverableSchemaChange({ backup, repair, sync, restore }) {
  const backupResult = backup();
  if (!backupResult.ok) return false;
  let failure = null;
  let completed;
  try {
    completed = repair() && sync();
  } catch (error) {
    failure = error;
    completed = false;
  }
  if (completed) return true;

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
  if (failure) {
    throw new SchemaChangeRestoredError("The database change failed after its backup was restored", {
      backupPath: backupResult.backupPath,
      cause: failure
    });
  }
  return false;
}
