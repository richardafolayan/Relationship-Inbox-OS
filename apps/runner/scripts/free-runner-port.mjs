#!/usr/bin/env node
// Pre-dev guard. `tsx watch` does NOT free its port cleanly when a new
// `npm run dev` is started alongside an old one: the loser of the bind
// race crashes with EADDRINUSE but its watcher parent lingers, then ALL
// lingering watchers stampede the port on the next file change. The
// dashboard's proxy then intermittently hits a moment where nothing owns
// :4001 and Next.js renders a bare "Internal Server Error".
//
// This script runs as `predev` (npm runs it automatically before `dev`)
// and clears the field before a fresh runner starts:
//   1. Kills whatever is LISTENing on the runner port.
//   2. Kills stray `tsx watch src/index.ts` watcher parents (the ones
//      that crashed on EADDRINUSE and no longer hold the port, so a
//      port check alone would miss them).
//
// It is deliberately best-effort: any failure (no lsof, no pgrep, races)
// must NOT block dev startup, so every step is wrapped and we always
// exit 0.

import { execSync } from "node:child_process";

const PORT = Number(process.env.RUNNER_PORT ?? 4001);
const selfPid = process.pid;
const parentPid = process.ppid;

/** Run a command, return trimmed stdout or "" on any failure. */
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** Parse a newline/space-separated PID blob into a unique numeric list. */
function pids(blob) {
  return [
    ...new Set(
      blob
        .split(/\s+/)
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ];
}

function killAll(targets, label) {
  const victims = targets.filter(
    (pid) => pid !== selfPid && pid !== parentPid
  );
  if (victims.length === 0) return;

  console.log(
    `[free-runner-port] ${label}: terminating ${victims.join(", ")}`
  );
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Give them a beat to exit on SIGTERM, then SIGKILL survivors.
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    /* busy-wait; predev is short-lived and this keeps it dependency-free */
  }
  for (const pid of victims) {
    try {
      process.kill(pid, 0); // throws if the process is gone
      process.kill(pid, "SIGKILL");
      console.log(`[free-runner-port] ${label}: SIGKILL ${pid}`);
    } catch {
      /* exited cleanly on SIGTERM */
    }
  }
}

// 1. Anything LISTENing on the runner port.
const portPids = pids(sh(`lsof -ti tcp:${PORT} -sTCP:LISTEN`));
killAll(portPids, `port :${PORT}`);

// 2. Stray watcher parents. During predev npm has not spawned our own
//    watcher yet, so any match here is a leftover from a previous run.
const watcherPids = pids(sh(`pgrep -f "tsx watch src/index.ts"`));
killAll(watcherPids, "stale tsx watch");

if (portPids.length === 0 && watcherPids.length === 0) {
  console.log(`[free-runner-port] port :${PORT} clear, no stale watchers`);
}

process.exit(0);
