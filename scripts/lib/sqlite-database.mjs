import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function splitFileUrl(value) {
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return { path: value, query: "" };
  return {
    path: value.slice(0, queryIndex),
    query: value.slice(queryIndex)
  };
}

export function prepareSqliteDatabaseFile(databaseUrl, { appDir, dataDir }) {
  const requestedUrl = databaseUrl?.trim() || `file:${join(dataDir, "inbox-os.sqlite")}`;
  if (!requestedUrl.startsWith("file:")) {
    return { created: false, databasePath: null, databaseUrl: requestedUrl };
  }

  const parsed = splitFileUrl(requestedUrl.slice("file:".length));
  const requestedPath = parsed.path || join(dataDir, "inbox-os.sqlite");
  const databasePath = resolve(
    isAbsolute(requestedPath) ? requestedPath : join(appDir, requestedPath)
  );
  mkdirSync(dirname(databasePath), { recursive: true });

  let descriptor;
  let created = false;
  try {
    descriptor = openSync(databasePath, "wx", 0o600);
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  return {
    created,
    databasePath,
    databaseUrl: `file:${databasePath}${parsed.query}`
  };
}
