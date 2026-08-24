import { execFileSync } from "node:child_process";

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function updateControlCommand(command) {
  const normalized = String(command || "").replaceAll("\\", "/").toLowerCase();
  return [
    "/scripts/start-student.mjs",
    "scripts/start-student.mjs",
    "/scripts/apply-update-and-restart.mjs",
    "scripts/apply-update-and-restart.mjs",
    "start:student"
  ].some((marker) => normalized.includes(marker));
}

function inspectAncestor(pid, platform, exec) {
  if (platform === "win32") {
    const output = exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" | ` +
          "Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress)"
      ],
      { encoding: "utf8" }
    ).trim();
    if (!output) return null;
    const row = JSON.parse(output);
    return {
      parentPid: positivePid(row?.ParentProcessId),
      command: row?.CommandLine || ""
    };
  }

  const output = exec(
    "ps",
    ["-p", String(pid), "-o", "ppid=,command="],
    { encoding: "utf8" }
  ).trim();
  const match = output.match(/^(\d+)\s+(.*)$/s);
  if (!match) return null;
  return { parentPid: positivePid(match[1]), command: match[2] };
}

export function updateControlAncestorPids({
  startPid = process.ppid,
  platform = process.platform,
  exec = execFileSync
} = {}) {
  const ancestors = [];
  const seen = new Set([process.pid]);
  let current = positivePid(startPid);
  for (let depth = 0; depth < 16 && current && current > 1 && !seen.has(current); depth += 1) {
    seen.add(current);
    let snapshot;
    try {
      snapshot = inspectAncestor(current, platform, exec);
    } catch {
      break;
    }
    if (!snapshot) break;
    if (updateControlCommand(snapshot.command)) ancestors.push(current);
    current = snapshot.parentPid;
  }
  return ancestors;
}
