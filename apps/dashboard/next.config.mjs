/** @type {import('next').NextConfig} */
const runnerPort = process.env.RUNNER_PORT ?? "4001";
const runnerBase = `http://localhost:${runnerPort}`;

const nextConfig = {
  reactStrictMode: true,
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
