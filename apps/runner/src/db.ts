import { PrismaClient } from "@prisma/client";
import { runnerConfig } from "./config";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${runnerConfig.dbFile}`;
}

declare global {
  var __inboxPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__inboxPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__inboxPrisma = prisma;
}
