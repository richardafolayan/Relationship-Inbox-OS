import test from "node:test";
import assert from "node:assert/strict";

// pilot-tour.ts is framework-free, so the tsx loader resolves this .ts
// import directly — see test:all in the root package.json.
const { isCurrentStartInvocation } = await import("../apps/dashboard/lib/pilot-tour.ts");

// Regression for P3-PL1: startTour resolves its sandbox POST and then reads the
// shared skipPendingRef and calls setState. skipPendingRef is one shared ref and
// the post-await branch guards only on prev.active (true for ANY running tour),
// with no token identifying which startTour invocation is resolving. Sequence:
//  1. startTour A sets bootstrapping:true and awaits startPilotSandbox (POST A).
//  2. Operator skips mid-bootstrap -> defer-teardown sets skipPendingRef=true,
//     state.active=false.
//  3. Operator replays -> startTour B runs, resets skipPendingRef=false and
//     awaits a SECOND startPilotSandbox (POST B in flight).
//  4. POST A now resolves inside A's closure, sees prev.active===true (tour B),
//     and writes bootstrapping:false — un-gating tour B before its seed landed.
// The fix tags each invocation with a monotonic token and bails in the post-await
// branches if the token is no longer current.

function nextToken(tokenRef) {
  // Mirrors `const invocationToken = ++startTokenRef.current` in PilotTour.tsx.
  tokenRef.current += 1;
  return tokenRef.current;
}

test("a stale startTour invocation is detected after a newer start began", () => {
  const tokenRef = { current: 0 };
  // startTour A captures its token, then its POST goes in flight.
  const tokenA = nextToken(tokenRef);
  // Operator skips mid-bootstrap, then replays: startTour B captures the next token.
  const tokenB = nextToken(tokenRef);
  // POST A resolves: A must recognise it is no longer the current invocation.
  assert.equal(
    isCurrentStartInvocation(tokenA, tokenRef.current),
    false,
    "the older invocation A must be stale once B has started"
  );
  // POST B resolves: B is still current and may finish bootstrapping normally.
  assert.equal(
    isCurrentStartInvocation(tokenB, tokenRef.current),
    true,
    "the newest invocation B must be recognised as current"
  );
});

test("the only-ever startTour invocation is always current after its POST resolves", () => {
  const tokenRef = { current: 0 };
  const token = nextToken(tokenRef);
  // No newer start happened, so the single tour finishes bootstrapping as before.
  assert.equal(isCurrentStartInvocation(token, tokenRef.current), true);
});

test("each invocation gets a distinct token so the newest always wins", () => {
  const tokenRef = { current: 0 };
  const tokens = [nextToken(tokenRef), nextToken(tokenRef), nextToken(tokenRef)];
  // All distinct.
  assert.equal(new Set(tokens).size, tokens.length);
  // Only the last captured token is current; every earlier one is stale.
  assert.equal(isCurrentStartInvocation(tokens[0], tokenRef.current), false);
  assert.equal(isCurrentStartInvocation(tokens[1], tokenRef.current), false);
  assert.equal(isCurrentStartInvocation(tokens[2], tokenRef.current), true);
});

test("the decision is a pure equality of the two tokens", () => {
  for (const [a, b] of [
    [1, 1],
    [1, 2],
    [5, 5],
    [9, 3]
  ]) {
    assert.equal(isCurrentStartInvocation(a, b), a === b);
  }
});
