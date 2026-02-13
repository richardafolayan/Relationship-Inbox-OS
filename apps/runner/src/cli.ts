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

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
