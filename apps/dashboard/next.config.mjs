/** @type {import('next').NextConfig} */
const useEventsProxy = process.env.USE_EVENTS_PROXY === "true";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/runner/:path*",
        destination: "http://localhost:4001/:path*"
      },
      {
        source: "/events",
        destination: useEventsProxy ? "/events-proxy" : "http://localhost:4001/events"
      },
      {
        source: "/artifacts/:type/:name",
        destination: "http://localhost:4001/artifacts/:type/:name"
      }
    ];
  }
};

export default nextConfig;
