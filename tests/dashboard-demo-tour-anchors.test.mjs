import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Guard: every anchor the guided flows (pilot tour + presenter demo) point at
// must exist as a `data-demo-target` (or legacy `data-tour`) in the dashboard
// source. A step that targets a non-existent anchor renders with no spotlight
// box (the bug behind the "Open Serena" and "Write the reply" reports), so
// adding a target without its anchor should fail here.
const { getPilotTourSteps } = await import("../apps/dashboard/lib/pilot-tour.ts");
const { FULL_DEMO_SCRIPT } = await import("../apps/dashboard/lib/full-demo-script.ts");

const pilotTargets = getPilotTourSteps().flatMap((s) => s.targets ?? []);
const presenterTargets = FULL_DEMO_SCRIPT.map((s) => s.target).filter(Boolean);
const targets = [...new Set([...pilotTargets, ...presenterTargets])];

function collectSource(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectSource(path, acc);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) acc.push(path);
  }
  return acc;
}

const src = ["apps/dashboard/components", "apps/dashboard/app"]
  .flatMap((dir) => collectSource(dir))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

// Static anchors: data-demo-target="x" / data-tour="x".
const literal = new Set(
  [...src.matchAll(/data-(?:demo-target|tour)="([a-z][a-z0-9-]+)"/g)].map((m) => m[1])
);
// Dynamic anchors from a template literal, e.g. data-demo-target={`nav-${...}`}
// or {row.platformThreadId ? `thread-row-${...}` : undefined}. The template can
// sit behind an expression, so allow non-`}` chars before the backtick.
// Captured as the static prefix before `${`.
const dynamicPrefixes = [
  ...src.matchAll(/data-(?:demo-target|tour)=\{[^}]*?`([a-z][a-z0-9-]*-)\$\{/g)
].map((m) => m[1]);

const satisfied = (target) =>
  literal.has(target) || dynamicPrefixes.some((prefix) => target.startsWith(prefix));

test("every guided-tour target anchor exists in the dashboard source", () => {
  assert.ok(targets.length > 0, "expected the tour scripts to declare targets");
  const missing = targets.filter((t) => !satisfied(t));
  assert.deepEqual(
    missing,
    [],
    `guided-tour steps target anchors with no data-demo-target in source: ${missing.join(", ")}`
  );
});

test("the dynamic nav and thread-row anchors are detected", () => {
  // Sanity check the dynamic-prefix detection so the guard above can't pass
  // by silently failing to see template-literal anchors.
  assert.ok(dynamicPrefixes.includes("nav-"), "expected a dynamic nav- anchor");
  assert.ok(dynamicPrefixes.includes("thread-row-"), "expected a dynamic thread-row- anchor");
  assert.ok(literal.has("composer-input"), "expected the composer-input anchor to be static");
});
