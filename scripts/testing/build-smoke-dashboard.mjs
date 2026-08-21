import { spawnSync } from "node:child_process";

const runnerPort = process.env.TOVI_SMOKE_RUNNER_PORT ?? "4311";
if (!/^\d{4,5}$/.test(runnerPort)) {
  throw new Error("TOVI_SMOKE_RUNNER_PORT must be a four or five digit port");
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Smoke dashboard build must run through npm");
}

const result = spawnSync(
  process.execPath,
  [npmCli, "run", "build", "--workspace", "@inbox-os/dashboard"],
  {
    env: { ...process.env, RUNNER_PORT: runnerPort },
    stdio: "inherit"
  }
);

process.exit(result.status ?? 1);
