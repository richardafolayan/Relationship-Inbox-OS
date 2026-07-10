#!/usr/bin/env node

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = resolve(ROOT, "packages/core/prisma/schema.prisma");
const DEFAULT_DATABASE_URL = `file:${resolve(ROOT, "data/inbox-os.sqlite")}`;
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

function databasePathFromUrl(url) {
  if (!url.startsWith("file:")) {
    throw new Error(`Only SQLite file: DATABASE_URL values are supported here. Got: ${url}`);
  }
  const withoutScheme = url.slice("file:".length).split("?")[0];
  if (!withoutScheme) {
    throw new Error("DATABASE_URL does not include a SQLite file path.");
  }
  return isAbsolute(withoutScheme) ? withoutScheme : resolve(ROOT, withoutScheme);
}

function prisma(args) {
  const bin = resolve(ROOT, "node_modules/.bin/prisma");
  const result = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(detail || `prisma ${args.join(" ")} failed`);
  }
  return result.stdout;
}

const dbPath = databasePathFromUrl(databaseUrl);
mkdirSync(dirname(dbPath), { recursive: true });

const hasDatabase = existsSync(dbPath) && statSync(dbPath).size > 0;
const fromArgs = hasDatabase ? ["--from-url", databaseUrl] : ["--from-empty"];
const sql = prisma([
  "migrate",
  "diff",
  ...fromArgs,
  "--to-schema-datamodel",
  SCHEMA_PATH,
  "--script"
]).trim();

if (!sql || sql === "-- This is an empty migration.") {
  process.stdout.write("SQLite schema is already up to date.\n");
  process.exit(0);
}

const db = new Database(dbPath);
try {
  db.pragma("foreign_keys = OFF");
  db.exec(sql);
  db.pragma("foreign_keys = ON");
} finally {
  db.close();
}

process.stdout.write(`SQLite schema synced at ${dbPath}.\n`);
