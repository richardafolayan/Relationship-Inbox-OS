import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";

function verifyDatabase(path) {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    const rows = database.pragma("quick_check");
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
      throw new Error("SQLite backup verification failed");
    }
  } finally {
    database.close();
  }
}

const input = process.argv.slice(2);
if (input[0] === "--verify") {
  if (!input[1] || !isAbsolute(input[1])) {
    throw new Error("Usage: backup-sqlite.mjs --verify <database.sqlite>");
  }
  verifyDatabase(resolve(input[1]));
  process.stdout.write("ok\n");
  process.exit(0);
}

const [sourceArgument, destinationArgument] = input;
if (!sourceArgument || !destinationArgument) {
  throw new Error("Usage: backup-sqlite.mjs <source.sqlite> <destination.sqlite>");
}
if (!isAbsolute(sourceArgument) || !isAbsolute(destinationArgument)) {
  throw new Error("SQLite backup paths must be absolute");
}

const source = resolve(sourceArgument);
const destination = resolve(destinationArgument);
if (source === destination) throw new Error("SQLite backup destination must differ from source");

await mkdir(dirname(destination), { recursive: true });
const temporary = join(
  dirname(destination),
  `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`
);
const temporaryFile = await open(temporary, "wx", 0o600);
await temporaryFile.close();
try {
  const database = new Database(source, { fileMustExist: true, readonly: true });
  try {
    await database.backup(temporary);
    await chmod(temporary, 0o600);
  } finally {
    database.close();
  }
  verifyDatabase(temporary);
  await Promise.all([
    rm(`${destination}-wal`, { force: true }),
    rm(`${destination}-shm`, { force: true }),
    rm(`${destination}-journal`, { force: true })
  ]);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  const restoredFile = await open(destination, "r+");
  try {
    await restoredFile.sync();
  } finally {
    await restoredFile.close();
  }
  if (process.platform !== "win32") {
    const destinationDirectory = await open(dirname(destination), "r");
    try {
      await destinationDirectory.sync();
    } finally {
      await destinationDirectory.close();
    }
  }
} finally {
  await rm(temporary, { force: true });
}
