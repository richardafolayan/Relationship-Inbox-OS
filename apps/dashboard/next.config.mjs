/** @type {import('next').NextConfig} */
const useEventsProxy = process.env.USE_EVENTS_PROXY === "true";
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
      {
        source: "/events",
        destination: useEventsProxy ? "/events-proxy" : `${runnerBase}/events`
      },
      {
        source: "/artifacts/:type/:name",
        destination: `${runnerBase}/artifacts/:type/:name`
      }
    ];
  }
};

export default nextConfig;
