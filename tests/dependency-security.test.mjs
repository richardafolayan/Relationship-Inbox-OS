import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const minimumSafeTarVersion = [7, 5, 21];

function stableVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, `expected a stable semantic version, received ${version}`);
  return match.slice(1).map(Number);
}

function isBeforeMinimum(version, minimum) {
  const parts = stableVersionParts(version);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] < minimum[index];
  }
  return false;
}

test("locked node-tar copies are outside the GHSA-r292-9mhp-454m affected range", () => {
  const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
  const tarPackages = Object.entries(lock.packages).filter(([path]) =>
    /(^|\/)node_modules\/tar$/.test(path)
  );
  const affected = tarPackages
    .filter(([, metadata]) => isBeforeMinimum(metadata.version, minimumSafeTarVersion))
    .map(([path, metadata]) => `${path}@${metadata.version}`);

  assert.deepEqual(affected, []);
});
