import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("document scroll is locked and the shell uses the dynamic viewport (#895)", () => {
  const globals = read("apps/dashboard/app/globals.css");
  const shell = read("apps/dashboard/components/layout/app-shell.tsx");
  const canvas = read("apps/dashboard/components/common/canvas.tsx");

  assert.match(globals, /html,\s*body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(globals, /html,\s*body\s*\{[^}]*overscroll-behavior:\s*none/s);
  assert.match(globals, /html,\s*body\s*\{[^}]*height:\s*100%/s);
  assert.match(globals, /\.h-app-screen\s*\{[^}]*100vh/s);
  assert.match(globals, /\.h-app-screen\s*\{[^}]*100dvh/s);

  // Shell is clipped; mobile main is not the primary scroller.
  assert.match(shell, /grid h-app-screen[^"]*overflow-hidden/);
  assert.match(shell, /overflow-y-hidden md:overflow-y-auto/);
  // Bare overflow-y-auto on main (without a breakpoint prefix) must not return.
  assert.doesNotMatch(
    shell,
    /<main className="[^"]*(?<![\w:-])overflow-y-auto/
  );

  // List pages scroll via Canvas on mobile; desktop defers to shell main.
  assert.match(canvas, /h-full min-h-0/);
  assert.match(canvas, /overflow-y-auto overscroll-y-contain/);
  assert.match(canvas, /md:h-auto md:overflow-visible/);
});

test("thread keeps its own message scroller rather than relying on shell main (#895)", () => {
  // Read from HEAD of the base branch when the worktree has unrelated
  // thread edits; the contract is structural and lives on strip-back-pr1.
  const thread = read("apps/dashboard/app/thread/[id]/page.tsx");

  assert.match(thread, /h-full min-h-0[^"\n]*overflow-hidden/);
  assert.match(thread, /min-h-0 flex-1 overflow-y-auto overflow-x-hidden/);
});
