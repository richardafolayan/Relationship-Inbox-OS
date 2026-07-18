import { join, win32 } from "node:path";

export function packagedDashboardArgs(appDir, port, platform = process.platform) {
  const pathApi = platform === "win32" ? win32 : { join };
  return [
    pathApi.join(appDir, "node_modules", "next", "dist", "bin", "next"),
    "start",
    pathApi.join(appDir, "apps", "dashboard"),
    "-p",
    String(port),
    "-H",
    "127.0.0.1"
  ];
}
