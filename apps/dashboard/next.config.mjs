/** @type {import('next').NextConfig} */
// Truthiness (not ??) so a set-but-blank RUNNER_PORT ("") falls back to
// the default instead of producing "http://localhost:" (port 80) and
// pointing the /runner and /artifacts rewrites at the wrong place.
import { resolveAppName } from "../../scripts/lib/branding.mjs";

const runnerPort = process.env.RUNNER_PORT?.trim() || "4001";
const runnerBase = `http://localhost:${runnerPort}`;

// The app display name is configured once via RIOS_APP_NAME (server, runner,
// scripts all read it). Expose it to the browser bundle as NEXT_PUBLIC_APP_NAME
// so a single .env variable renames the app everywhere. Falls back to "Tovi".
const appName = resolveAppName({
  RIOS_APP_NAME: process.env.RIOS_APP_NAME || process.env.NEXT_PUBLIC_APP_NAME
});

const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_NAME: appName
  },
  // @inbox-os/core ships TypeScript source with NodeNext (".js") import
  // specifiers. The dashboard now imports its birthday/date helpers at
  // runtime (not just as types), so Next must transpile the package to
  // resolve those specifiers and bundle it.
  transpilePackages: ["@inbox-os/core"],
  async rewrites() {
    return [
      {
        source: "/runner/:path*",
        destination: `${runnerBase}/:path*`
      },
      // SSE always goes through the in-app `/events-proxy` route. The
      // default Next rewrite buffers the chunked response so the
      // dashboard never sees real-time events (#127). The proxy route
      // forwards the runner stream as-is. The previous USE_EVENTS_PROXY
      // env toggle defaulted to false and silently broke SSE on every
      // dev install that didn't symlink .env into apps/dashboard.
      {
        source: "/events",
        destination: "/events-proxy"
      },
      {
        source: "/artifacts/:type/:name",
        destination: `${runnerBase}/artifacts/:type/:name`
      }
    ];
  }
};

export default nextConfig;
