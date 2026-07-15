import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WINDOWS_NODE_MAJOR = 22;
export const WINDOWS_ARCHES = new Set(["x64", "arm64"]);

export function nodeArchiveName(version, arch) {
  if (!WINDOWS_ARCHES.has(arch)) throw new Error(`Unsupported Windows architecture: ${arch}`);
  return `node-v${version}-win-${arch}.zip`;
}

export function checksumForArchive(sums, archiveName) {
  const line = String(sums)
    .split(/\r?\n/)
    .find((entry) => entry.trim().endsWith(`  ${archiveName}`));
  if (!line) throw new Error(`Node checksum list does not contain ${archiveName}`);
  return line.trim().split(/\s+/, 1)[0];
}

export function windowsRuntimeDir(root = ROOT, arch = "x64") {
  return resolve(root, "build", "windows-runtime", arch);
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function nodeMajor(versionText) {
  const match = String(versionText).trim().match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

function preparedRuntimeIsUsable(targetDir) {
  const nodeExe = join(targetDir, "node.exe");
  if (!existsSync(nodeExe)) return false;
  const result = spawnSync(nodeExe, ["-v"], { encoding: "utf8" });
  return result.status === 0 && nodeMajor(result.stdout) === WINDOWS_NODE_MAJOR;
}

export async function prepareWindowsRuntime({ arch = "x64", root = ROOT } = {}) {
  if (process.platform !== "win32") {
    throw new Error("The Windows runtime must be prepared on Windows.");
  }
  if (!WINDOWS_ARCHES.has(arch)) throw new Error(`Unsupported Windows architecture: ${arch}`);

  const targetDir = windowsRuntimeDir(root, arch);
  if (preparedRuntimeIsUsable(targetDir)) return targetDir;

  const releaseBase = `https://nodejs.org/download/release/latest-v${WINDOWS_NODE_MAJOR}.x`;
  const sums = (await download(`${releaseBase}/SHASUMS256.txt`)).toString("utf8");
  const versionMatch = sums.match(new RegExp(`node-v(${WINDOWS_NODE_MAJOR}\\.[0-9]+\\.[0-9]+)-win-${arch}\\.zip`));
  if (!versionMatch) throw new Error(`Could not find Node ${WINDOWS_NODE_MAJOR} for win-${arch}`);

  const version = versionMatch[1];
  const archiveName = nodeArchiveName(version, arch);
  const expectedChecksum = checksumForArchive(sums, archiveName);
  const archive = await download(`${releaseBase}/${archiveName}`);
  const actualChecksum = createHash("sha256").update(archive).digest("hex");
  if (actualChecksum !== expectedChecksum) throw new Error(`Checksum mismatch for ${archiveName}`);

  const tempDir = mkdtempSync(join(tmpdir(), "tovi-windows-node-"));
  const archivePath = join(tempDir, archiveName);
  const extractDir = join(tempDir, "extracted");
  try {
    writeFileSync(archivePath, archive);
    mkdirSync(extractDir, { recursive: true });
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:TOVI_NODE_ARCHIVE -DestinationPath $env:TOVI_NODE_DEST -Force"
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          TOVI_NODE_ARCHIVE: archivePath,
          TOVI_NODE_DEST: extractDir
        }
      }
    );
    const extractedRoot = readdirSync(extractDir)
      .map((entry) => join(extractDir, entry))
      .find((entry) => existsSync(join(entry, "node.exe")));
    if (!extractedRoot) throw new Error(`The ${archiveName} archive did not contain node.exe`);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    cpSync(extractedRoot, targetDir, { recursive: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (!preparedRuntimeIsUsable(targetDir)) {
    throw new Error(`Node ${WINDOWS_NODE_MAJOR} did not install correctly at ${targetDir}`);
  }
  return targetDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archArg = process.argv.find((arg) => arg.startsWith("--arch="));
  const arch = archArg?.slice("--arch=".length) || "x64";
  const target = await prepareWindowsRuntime({ arch });
  process.stdout.write(`${target}\n`);
}
