import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
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

async function reclaimAbandonedOwnedDirectory(directoryPath) {
  let entries;
  try {
    entries = (await readdir(directoryPath)).filter(
      (entry) => entry.startsWith("owner-") && entry.endsWith(".json")
    );
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return false;
    throw error;
  }

  for (const entry of entries) {
    try {
      const owner = JSON.parse(await readFile(join(directoryPath, entry), "utf8"));
      if (Number.isInteger(owner.pid) && processIsAlive(owner.pid)) return false;
    } catch (error) {
      const isMissing = error?.code === "ENOENT";
      if (!isMissing && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  for (const entry of entries) {
    await rm(join(directoryPath, entry), { force: true });
  }
  try {
    await rmdir(directoryPath);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST", "EACCES", "EPERM"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

async function acquireReclaimCoordinator(lockPath) {
  const coordinatorPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  const ownerFileName = `owner-${token}.json`;
  const candidatePath = `${coordinatorPath}.candidate-${token}`;
  await mkdir(candidatePath);
  await writeFile(
    join(candidatePath, ownerFileName),
    JSON.stringify({ pid: process.pid, token })
  );

  while (true) {
    try {
      await rename(candidatePath, coordinatorPath);
      break;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error?.code)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw error;
      }
    }
    if (await reclaimAbandonedOwnedDirectory(coordinatorPath)) continue;
    await rm(candidatePath, { recursive: true, force: true });
    return null;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(join(coordinatorPath, ownerFileName), { force: true });
    try {
      await rmdir(coordinatorPath);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EACCES", "EPERM"].includes(error?.code)) {
        throw error;
      }
    }
  };
}

async function reclaimAbandonedLease(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch {
    return false;
  }
  if (Number.isInteger(owner.pid) && processIsAlive(owner.pid)) return false;

  const releaseCoordinator = await acquireReclaimCoordinator(lockPath);
  if (!releaseCoordinator) return false;

  try {
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
  } finally {
    await releaseCoordinator();
  }
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
