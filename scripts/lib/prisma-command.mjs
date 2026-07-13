import { join, win32 } from "node:path";

export function prismaDbPushInvocation({
  appDir,
  packaged,
  nodeExecutable = process.execPath,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  platform = process.platform
}) {
  const args = [
    "db",
    "push",
    "--schema",
    "packages/core/prisma/schema.prisma",
    "--skip-generate"
  ];
  if (packaged) {
    const pathApi = platform === "win32" ? win32 : { join };
    return {
      command: nodeExecutable,
      args: [pathApi.join(appDir, "node_modules", "prisma", "build", "index.js"), ...args]
    };
  }
  return { command: npmCommand, args: ["exec", "--", "prisma", ...args] };
}
