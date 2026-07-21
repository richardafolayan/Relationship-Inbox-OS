import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/start-app.mjs", import.meta.url), "utf8");

test("native module rebuild uses the same Node runtime as the launcher", () => {
  assert.match(source, /new NativeModule\(':memory:'\)/);
  assert.match(source, /database\.close\(\)/);
  assert.match(source, /PATH: \[dirname\(process\.execPath\), process\.env\.PATH\]/);
  assert.match(
    source,
    /\["rebuild", "better-sqlite3"\],[\s\S]*?\{ env: runtimeCommandEnv\(\) \}/
  );
});
