// Resolve the runner base URL the same way next.config.mjs derives the
// `/runner` and `/artifacts` rewrites: a single RUNNER_PORT controls every
// path to the runner, with RUNNER_ORIGIN as an optional full-origin override.
// Kept in lib/ (not the route file) because Next.js route modules may only
// export request handlers — exporting a helper from route.ts is a type error.
export function resolveRunnerBase(): string {
  return (
    process.env.RUNNER_ORIGIN ??
    `http://localhost:${process.env.RUNNER_PORT ?? "4001"}`
  );
}
