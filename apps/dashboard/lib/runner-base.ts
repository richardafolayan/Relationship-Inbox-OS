// Resolve the runner base URL the same way next.config.mjs derives the
// `/runner` and `/artifacts` rewrites: a single RUNNER_PORT controls every
// path to the runner, with RUNNER_ORIGIN as an optional full-origin override.
// Kept in lib/ (not the route file) because Next.js route modules may only
// export request handlers — exporting a helper from route.ts is a type error.
export function resolveRunnerBase(): string {
  // Use truthiness (not ??) so a set-but-blank env var counts as unset:
  // RUNNER_ORIGIN="" must not return "" (new URL("/events", "") throws and
  // the SSE proxy 500s), and RUNNER_PORT="" must not yield "http://localhost:".
  const origin = process.env.RUNNER_ORIGIN?.trim();
  if (origin) {
    return origin;
  }
  const port = process.env.RUNNER_PORT?.trim() || "4001";
  return `http://localhost:${port}`;
}
