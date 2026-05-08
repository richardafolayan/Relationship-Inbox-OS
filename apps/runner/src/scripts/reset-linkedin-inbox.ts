import type { PlatformName } from "@inbox-os/core";
import {
  AdminResetGuardError,
  resetPlatformInboxGraph,
  validateAdminResetGuards
} from "../services/admin-reset.js";

interface CliOptions {
  platform: PlatformName;
  token?: string;
  confirm?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    platform: "LINKEDIN"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      const value = (argv[index + 1] ?? "").toUpperCase();
      if (value === "LINKEDIN" || value === "INSTAGRAM" || value === "TIKTOK" || value === "IMESSAGE") {
        options.platform = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--token") {
      options.token = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--confirm") {
      options.confirm = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

async function run(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const token = options.token ?? process.env.ADMIN_RESET_TOKEN;
  const confirm = options.confirm ?? "RESET";

  validateAdminResetGuards({
    token,
    confirm
  });

  const result = await resetPlatformInboxGraph(options.platform);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        status: "ok",
        ...result
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  if (error instanceof AdminResetGuardError) {
    // eslint-disable-next-line no-console
    console.error(`[admin-reset] ${error.message}`);
    process.exit(error.statusCode === 400 ? 2 : 1);
  }
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
