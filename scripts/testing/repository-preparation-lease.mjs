import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function reclaimAbandonedLease(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return false;
  }
  if (Number.isInteger(owner.pid) && processIsAlive(owner.pid)) return false;

  const abandonedPath = `${lockPath}.abandoned-${randomUUID()}`;
  try {
    await rename(lockPath, abandonedPath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
  await rm(abandonedPath, { recursive: true, force: true });
  return true;
}

export async function acquireRepositoryPreparationLease(
  repoRoot,
  { pollMilliseconds = 50, timeoutMilliseconds = 120_000 } = {}
) {
  const token = randomUUID();
  const lockPath = join(repoRoot, ".tovi-test-preparation.lock");
  const candidatePath = `${lockPath}.candidate-${token}`;
  await mkdir(candidatePath);
  await writeFile(
    join(candidatePath, "owner.json"),
    JSON.stringify({ pid: process.pid, token })
  );

  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    try {
      await rename(candidatePath, lockPath);
      break;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw error;
      }
    }
    if (await reclaimAbandonedLease(lockPath)) continue;
    if (Date.now() >= deadline) {
      await rm(candidatePath, { recursive: true, force: true });
      throw new Error("Timed out waiting for repository test preparation.");
    }
    await delay(pollMilliseconds);
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let owner;
    try {
      owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    } catch {
      return;
    }
    if (owner.token !== token) return;

    const releasedPath = `${lockPath}.released-${token}`;
    try {
      await rename(lockPath, releasedPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await rm(releasedPath, { recursive: true, force: true });
  };
}
