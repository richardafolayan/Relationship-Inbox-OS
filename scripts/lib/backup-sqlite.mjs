import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";

const [sourceArgument, destinationArgument] = process.argv.slice(2);
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
const database = new Database(source, { fileMustExist: true, readonly: true });
try {
  await database.backup(destination);
} finally {
  database.close();
}
