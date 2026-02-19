import { runLinkedInSmokeDirect } from "./services/linkedin-smoke-direct";

const baseUrl = `http://localhost:${process.env.RUNNER_PORT ?? 4001}`;

async function call(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }

  // eslint-disable-next-line no-console
  console.log(text);
}

function isRunnerUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED/i.test(message) || /fetch failed/i.test(message)) {
    return true;
  }
  if (!error || typeof error !== "object" || !("cause" in error)) {
    return false;
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeText = String(cause ?? "");
  if (/ECONNREFUSED/i.test(causeText)) {
    return true;
  }
  if (cause && typeof cause === "object" && "errors" in cause && Array.isArray((cause as { errors?: unknown[] }).errors)) {
    return (cause as { errors: unknown[] }).errors.some((entry) => /ECONNREFUSED/i.test(String(entry)));
  }
  return false;
}

async function run(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === "scan") {
    await call("/control/scan", {});
    return;
  }

  if (command === "connect") {
    if (!arg) {
      throw new Error("Missing platform argument");
    }
    await call("/control/platform/connect", { platform: arg });
    return;
  }

  if (command === "test-selectors") {
    if (!arg) {
      throw new Error("Missing platform argument");
    }
    await call("/control/platform/test-selectors", { platform: arg });
    return;
  }

  if (command === "linkedin-smoke") {
    try {
      await call("/control/platform/linkedin/smoke-unread", {});
    } catch (error) {
      if (!isRunnerUnavailable(error)) {
        throw error;
      }

      // eslint-disable-next-line no-console
      console.info(`[linkedin-smoke] runner unavailable at ${baseUrl}; falling back to direct mode`);
      const result = await runLinkedInSmokeDirect();

      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result));

      if (!result.ok) {
        throw new Error(`LinkedIn smoke failed (${result.reason}) at ${result.stage}: ${result.error}`);
      }
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
