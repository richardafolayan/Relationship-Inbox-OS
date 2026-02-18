export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
    readonly rawText?: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function parseErrorPayload(response: Response): Promise<{ payload?: unknown; rawText?: string }> {
  const rawText = await response.text();
  if (!rawText) {
    return {};
  }

  try {
    return {
      payload: JSON.parse(rawText),
      rawText
    };
  } catch {
    return {
      rawText
    };
  }
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const parsed = await parseErrorPayload(response);
    const message =
      (typeof parsed.payload === "object" &&
      parsed.payload &&
      "error" in parsed.payload &&
      typeof (parsed.payload as { error?: unknown }).error === "string"
        ? (parsed.payload as { error: string }).error
        : undefined) ??
      parsed.rawText ??
      `Request failed: ${response.status}`;
    throw new ApiRequestError(message, response.status, parsed.payload, parsed.rawText);
  }

  return (await response.json()) as T;
}
