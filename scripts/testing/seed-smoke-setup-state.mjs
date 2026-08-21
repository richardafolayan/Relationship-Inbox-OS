import { PrismaClient } from "@prisma/client";
import { basename, resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl.startsWith("file:")) {
  throw new Error("Smoke setup state requires a file-backed DATABASE_URL");
}

const databasePath = resolve(databaseUrl.slice("file:".length));
if (!basename(databasePath).startsWith("tovi-smoke-") || !/(perf|benchmark)/i.test(databasePath)) {
  throw new Error("Smoke setup state requires an isolated tovi-smoke performance fixture");
}

const completedAt = "2026-08-21T00:00:00.000Z";
const prisma = new PrismaClient();

function record(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

try {
  const existing = await prisma.setting.findMany({
    where: {
      key: { in: ["app_settings", "setup_preferences_v2", "operator_profile_v1"] }
    }
  });
  const valueFor = (key) => record(existing.find((row) => row.key === key)?.valueJson);

  const appSettings = {
    ...valueFor("app_settings"),
    enabledPlatforms: ["LINKEDIN"],
    aiEnabled: false
  };
  const setupPreferences = {
    ...valueFor("setup_preferences_v2"),
    selectedPlatforms: ["LINKEDIN"],
    aiEnabled: false,
    transcriptionMode: "off",
    startedAt: completedAt,
    completedAt
  };
  const operatorProfile = {
    ...valueFor("operator_profile_v1"),
    setupCompletedAt: completedAt
  };

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: "app_settings" },
      update: { valueJson: JSON.stringify(appSettings) },
      create: { key: "app_settings", valueJson: JSON.stringify(appSettings) }
    }),
    prisma.setting.upsert({
      where: { key: "setup_preferences_v2" },
      update: { valueJson: JSON.stringify(setupPreferences) },
      create: { key: "setup_preferences_v2", valueJson: JSON.stringify(setupPreferences) }
    }),
    prisma.setting.upsert({
      where: { key: "operator_profile_v1" },
      update: { valueJson: JSON.stringify(operatorProfile) },
      create: { key: "operator_profile_v1", valueJson: JSON.stringify(operatorProfile) }
    })
  ]);
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify({ databasePath, setupCompletedAt: completedAt }));
