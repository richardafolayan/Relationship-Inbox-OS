import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadAppEnv(appDir, target = process.env) {
  const env = readEnvFile(join(appDir, ".env"));
  for (const [key, value] of Object.entries(env)) {
    if (target[key] === undefined) target[key] = value;
  }
  return target;
}
