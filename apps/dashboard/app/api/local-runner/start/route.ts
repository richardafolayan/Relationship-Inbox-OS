import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const runtime = "nodejs";

function readPackageName(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof parsed?.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (readPackageName(dir) === "relationship-inbox-os") return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "../..");
}

async function runnerUp(): Promise<boolean> {
  const port = process.env.RUNNER_PORT || "4001";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(): Promise<Response> {
  if (await runnerUp()) {
    return Response.json({ ok: true, status: "already_running" });
  }

  const projectRoot = findProjectRoot();
  if (!existsSync(join(projectRoot, "package.json"))) {
    return Response.json({ ok: false, reason: "project_root_not_found" }, { status: 500 });
  }

  const logsDir = join(projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  const fd = openSync(join(logsDir, "runner-start.log"), "a");
  try {
    const child = spawn("npm", ["run", "dev:runner"], {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", fd, fd]
    });
    child.on("error", (error) => {
      console.warn("[local-runner] failed to start runner", error);
    });
    child.unref();
    return Response.json({ ok: true, status: "starting", pid: child.pid }, { status: 202 });
  } finally {
    closeSync(fd);
  }
}
