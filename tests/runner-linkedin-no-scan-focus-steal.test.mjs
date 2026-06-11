import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Issue #420 / pilot R-0046 (and the desktop-switch half of #403).
// Background scans must not steal Chrome focus. bringToFront() pulls
// the LinkedIn window to the foreground and (on macOS) can drag the
// operator onto whichever Space the runner's Chrome lives on.
//
// navigateInbox() is called from six background paths
// (scanInboxThreadsStream, scanInboxThreadsDirectFallback,
// ensureConnected, scanUnreadThreads, fetchRecentThreads,
// fetchThreadMessages); a focus-stealing call here disrupts the
// operator on every scan tick.
//
// openThread() and openProfileUrl() are operator-initiated — an
// explicit "open this thing" click — so they keep their own
// bringToFront().
//
// This test pins the invariant at the source level: every
// bringToFront() in the adapter must live inside a method whose name
// matches an allowlist of explicitly operator-initiated entry points.
// If a regression adds bringToFront() back to navigateInbox (or to
// any new scan-path method), the test fails loudly with the offending
// container method name.

const ADAPTER_PATH = "apps/runner/src/platforms/linkedin-adapter.ts";

// Methods where a foreground raise is intentional: the operator just
// clicked something that says "open this thing".  Extend this
// allowlist only after explicitly considering whether a new caller is
// really operator-initiated; scan/fetch paths must never be added.
const OPERATOR_INITIATED_METHODS = new Set(["openThread", "openProfileUrl"]);

// Remove TS line and block comments before scanning so a regression-
// test reference like "the bringToFront() that used to live here"
// inside a comment doesn't trigger a false positive. The
// substitution preserves length so source offsets the test reports
// still match the original file.
function stripComments(source) {
  // Block comments first so `// foo /* bar */ baz` inside a string-
  // adjacent context doesn't get mishandled by the line-comment pass.
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
  stripped = stripped.replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) =>
    prefix + " ".repeat(match.length - prefix.length)
  );
  return stripped;
}

function locateContainingMethodName(source, offset) {
  // Walk backwards from `offset` looking for the nearest enclosing
  // `methodName(...): ReturnType` signature. The adapter is a TS
  // class and its public/private methods have stable shapes. This is
  // intentionally narrow — we want the immediate enclosing method,
  // not "any name that appears earlier in the file".
  const prefix = source.slice(0, offset);
  const matches = [
    ...prefix.matchAll(
      /(?:^|\n)\s*(?:public |private |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^\n{]+)?\s*\{/g
    )
  ];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

test("every focus-raising call in linkedin-adapter sits inside an operator-initiated method", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), ADAPTER_PATH), "utf8"));
  // The operator focus-raise moved from a bare page.bringToFront() to
  // revealBrowserWindow() (un-minimize + on-screen + raise), since launches
  // are now hidden by default (the send/scan focus-steal fix). Either form is
  // a "surface Chrome to the operator" call and must stay out of scan/send
  // paths. The `import` of revealBrowserWindow is excluded.
  const occurrences = [...source.matchAll(/\b(?:bringToFront\s*\(\s*\)|revealBrowserWindow\s*\()/g)].filter(
    (m) => !source.slice(Math.max(0, m.index - 40), m.index).includes("import")
  );

  assert.ok(
    occurrences.length > 0,
    "expected at least one focus-raising call — openThread/openProfileUrl surface Chrome on operator clicks"
  );

  const offenders = [];
  for (const occurrence of occurrences) {
    const containing = locateContainingMethodName(source, occurrence.index ?? 0);
    if (!containing || !OPERATOR_INITIATED_METHODS.has(containing)) {
      offenders.push({
        method: containing ?? "(unknown — could not parse enclosing method)",
        sourceOffset: occurrence.index
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `focus-raising call found in non-operator-initiated method(s): ${JSON.stringify(
      offenders,
      null,
      2
    )}. Background scans (navigateInbox / scanInboxThreadsStream / etc.) MUST NOT steal focus — see issue #420 / pilot R-0046.`
  );
});

test("navigateInbox does not call bringToFront (regression guard for #420)", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), ADAPTER_PATH), "utf8"));

  // Extract the navigateInbox method body. The closing brace search
  // is balanced-aware enough for the adapter's idiomatic indentation:
  // the method ends at the first `\n  }` after the opening.
  const start = source.search(/\bprivate async navigateInbox\s*\(/);
  assert.notEqual(start, -1, "navigateInbox method not found");

  // Walk forward until the matching method-close. The adapter
  // consistently formats class methods with the closing `}` on its
  // own line indented by 2 spaces; relying on that keeps the parser
  // a one-liner without bringing in a TS AST library.
  const end = source.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, "could not find navigateInbox closing brace");
  const body = source.slice(start, end);

  assert.doesNotMatch(
    body,
    /\bbringToFront\s*\(/,
    "navigateInbox must not call bringToFront — it runs on every background scan and would drag Chrome to the foreground / switch macOS Spaces"
  );
});
