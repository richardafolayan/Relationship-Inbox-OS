import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PersonalProfileSyncMode } from "../config";

const mirrorMetadataFile = ".inbox-os-mirror-meta.json";
const profileMarkerFiles = [
  "Preferences",
  "Cookies",
  "History",
  "Login Data",
  "Web Data",
  "Bookmarks",
  "Visited Links"
];
const excludedNames = new Set([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "DevToolsActivePort",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnCache",
  "Crashpad",
  "blob_storage",
  "Service Worker",
  "BrowserMetrics",
  "Safe Browsing",
  "OptimizationGuidePredictionModels",
  "pnacl",
  "MEIPreload",
  "ZxcvbnData",
  "GraphiteDawnCache",
  "segmentation_platform",
  ".org.chromium.Chromium",
  "component_crx_cache",
  "CertificateRevocation"
]);

interface MirrorMetadata {
  mirroredAt: string;
  sourceMarkerMtimeMs: number;
  profileDirectory: string;
}

export interface PersonalProfileMirrorInput {
  sourceUserDataDir: string;
  targetUserDataDir: string;
  profileDirectory: string;
  syncMode: PersonalProfileSyncMode;
}

export interface PersonalProfileMirrorResult {
  syncPerformed: boolean;
  syncReason: "sync_disabled" | "target_missing" | "source_newer" | "source_not_newer" | "forced_sync";
  sourceUserDataDir: string;
  targetUserDataDir: string;
  profileDirectory: string;
  sourceProfileDir: string;
  targetProfileDir: string;
  sourceMarkerMtimeMs: number;
  lastMirroredSourceMarkerMtimeMs?: number;
  durationMs: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shouldExclude(name: string): boolean {
  if (excludedNames.has(name)) {
    return true;
  }
  if (name.startsWith("Singleton")) {
    return true;
  }
  return false;
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) {
      continue;
    }

    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(resolve(targetPath, ".."), { recursive: true });
      await copyFile(sourcePath, targetPath);
      continue;
    }
  }
}

async function safeStatMtimeMs(path: string): Promise<number | undefined> {
  try {
    const stats = await stat(path);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

async function resolveSourceMarkerMtimeMs(sourceUserDataDir: string, sourceProfileDir: string): Promise<number> {
  const markerCandidates = [
    resolve(sourceUserDataDir, "Local State"),
    sourceProfileDir,
    ...profileMarkerFiles.map((name) => resolve(sourceProfileDir, name))
  ];

  let max = 0;
  for (const candidate of markerCandidates) {
    const mtimeMs = await safeStatMtimeMs(candidate);
    if (typeof mtimeMs === "number" && mtimeMs > max) {
      max = mtimeMs;
    }
  }

  return max;
}

async function readMirrorMetadata(targetUserDataDir: string): Promise<MirrorMetadata | null> {
  const metadataPath = resolve(targetUserDataDir, mirrorMetadataFile);
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  try {
    const raw = await readFile(metadataPath, "utf8");
    return JSON.parse(raw) as MirrorMetadata;
  } catch {
    return null;
  }
}

async function writeMirrorMetadata(targetUserDataDir: string, metadata: MirrorMetadata): Promise<void> {
  const metadataPath = resolve(targetUserDataDir, mirrorMetadataFile);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

export async function preparePersonalProfileMirror(input: PersonalProfileMirrorInput): Promise<PersonalProfileMirrorResult> {
  const startedAt = Date.now();
  const sourceProfileDir = resolve(input.sourceUserDataDir, input.profileDirectory);
  const targetProfileDir = resolve(input.targetUserDataDir, input.profileDirectory);
  const sourceLocalStatePath = resolve(input.sourceUserDataDir, "Local State");
  const targetLocalStatePath = resolve(input.targetUserDataDir, "Local State");

  await mkdir(input.targetUserDataDir, { recursive: true });

  if (!(await pathExists(sourceProfileDir))) {
    throw new Error(`Personal Chrome profile directory is missing: ${sourceProfileDir}`);
  }

  const sourceMarkerMtimeMs = await resolveSourceMarkerMtimeMs(input.sourceUserDataDir, sourceProfileDir);
  const previousMetadata = await readMirrorMetadata(input.targetUserDataDir);
  const lastMirroredSourceMarkerMtimeMs = previousMetadata?.sourceMarkerMtimeMs;
  const targetReady = (await pathExists(targetProfileDir)) && (await pathExists(targetLocalStatePath));

  let shouldSync = false;
  let syncReason: PersonalProfileMirrorResult["syncReason"] = "source_not_newer";

  if (input.syncMode === "never") {
    syncReason = "sync_disabled";
  } else if (input.syncMode === "always") {
    shouldSync = true;
    syncReason = "forced_sync";
  } else if (!targetReady || typeof lastMirroredSourceMarkerMtimeMs !== "number") {
    shouldSync = true;
    syncReason = "target_missing";
  } else if (sourceMarkerMtimeMs > lastMirroredSourceMarkerMtimeMs) {
    shouldSync = true;
    syncReason = "source_newer";
  }

  if (shouldSync) {
    await rm(targetProfileDir, { recursive: true, force: true });
    await copyTree(sourceProfileDir, targetProfileDir);
    if (await pathExists(sourceLocalStatePath)) {
      await copyFile(sourceLocalStatePath, targetLocalStatePath);
    }
    await writeMirrorMetadata(input.targetUserDataDir, {
      mirroredAt: new Date().toISOString(),
      sourceMarkerMtimeMs,
      profileDirectory: input.profileDirectory
    });
  }

  return {
    syncPerformed: shouldSync,
    syncReason,
    sourceUserDataDir: input.sourceUserDataDir,
    targetUserDataDir: input.targetUserDataDir,
    profileDirectory: input.profileDirectory,
    sourceProfileDir,
    targetProfileDir,
    sourceMarkerMtimeMs,
    lastMirroredSourceMarkerMtimeMs,
    durationMs: Date.now() - startedAt
  };
}
