import { PrismaClient } from "@prisma/client";
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
