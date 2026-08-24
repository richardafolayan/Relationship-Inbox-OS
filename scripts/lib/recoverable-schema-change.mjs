export class SchemaRestoreError extends Error {
  constructor(message, { backupPath = null, databaseExisted = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SchemaRestoreError";
    this.backupPath = backupPath;
    this.databaseExisted = databaseExisted;
  }
}

export class SchemaChangeRestoredError extends Error {
  constructor(message, { backupPath = null, databaseExisted = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SchemaChangeRestoredError";
    this.backupPath = backupPath;
    this.databaseExisted = databaseExisted;
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
    restored = restore(backupResult.backupPath, backupResult);
  } catch (cause) {
    throw new SchemaRestoreError("The prior database state could not be restored", {
      backupPath: backupResult.backupPath,
      databaseExisted: backupResult.databaseExisted !== false,
      cause
    });
  }
  if (!restored) {
    throw new SchemaRestoreError("The prior database state could not be restored", {
      backupPath: backupResult.backupPath,
      databaseExisted: backupResult.databaseExisted !== false
    });
  }
  if (failure) {
    throw new SchemaChangeRestoredError("The database change failed after its prior state was restored", {
      backupPath: backupResult.backupPath,
      databaseExisted: backupResult.databaseExisted !== false,
      cause: failure
    });
  }
  return false;
}
