#!/usr/bin/env node

import { resolve } from "node:path";
import { repairDatabaseBeforeSchemaSync } from "./lib/preflight-schema-repairs.mjs";

const databaseUrl = process.env.DATABASE_URL || `file:${resolve("data/inbox-os.sqlite")}`;
if (!databaseUrl.startsWith("file:")) process.exit(0);

const databasePath = databaseUrl.slice("file:".length).split("?", 1)[0];
const result = repairDatabaseBeforeSchemaSync(databasePath);
if (result.removedDrafts > 0 || result.clearedReplyLinks > 0) {
  process.stdout.write(
    `Repaired ${result.removedDrafts} duplicate drafts and ${result.clearedReplyLinks} invalid reply links.\n`
  );
}
