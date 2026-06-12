import { PrismaClient } from "@prisma/client";
import SqliteDatabase from "better-sqlite3";
import { runnerConfig, resolveDatabaseUrl, projectRoot } from "./config";

// Normalise DATABASE_URL to an absolute SQLite file path before the Prisma
// client is constructed. A relative `file:` URL (e.g. the .env.example
// default) would otherwise be resolved by Prisma against the schema dir,
// not the project root — leaving the runner on a different, empty database
// from the one `npm run db:push` populated. See resolveDatabaseUrl.
process.env.DATABASE_URL = resolveDatabaseUrl(
  process.env.DATABASE_URL,
  projectRoot,
  runnerConfig.dbFile
);

declare global {
  var __inboxPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__inboxPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__inboxPrisma = prisma;
}

// SQLite journal mode. The database had been running in the default
// `delete` mode, where every write transaction holds an exclusive lock that
// blocks EVERY reader for its duration - so during a scan's upserts (or any
// send/audit write) the dashboard's /data reads queued behind the writer.
// WAL lets readers proceed while one writer appends, and the setting
// persists in the database file, so one successful run covers every later
// boot. Set via a short-lived DIRECT connection at module load: changing
// journal mode needs the database free of other writers, so an in-pool
// PRAGMA raced Prisma's own boot queries and failed silently.
try {
  const dbFile = (process.env.DATABASE_URL ?? "").replace(/^file:/, "").split("?")[0] ?? "";
  if (dbFile) {
    const direct = new SqliteDatabase(dbFile);
    direct.pragma("journal_mode = WAL");
    direct.close();
  }
} catch {
  // Pragmas are an optimisation - never block boot on them.
}
