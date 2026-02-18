import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLinkedInPreviewMap } from "../apps/runner/dist/platforms/linkedin-adapter.js";

test("LinkedIn preview map keeps thread previews isolated per platformThreadId", async () => {
  const fixturePath = join(process.cwd(), "tests", "fixtures", "linkedin", "thread-list-snapshots.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  const previewMap = buildLinkedInPreviewMap(fixture);
  assert.equal(previewMap.size, 3);

  const first = previewMap.get("linkedin-urn:urn:li:msg_thread:123");
  const second = previewMap.get("linkedin-urn:urn:li:msg_thread:456");
  const third = previewMap.get("linkedin-urn:urn:li:msg_thread:789");

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.notEqual(first, third);
});
