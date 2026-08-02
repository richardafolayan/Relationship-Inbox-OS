"use client";

const LEASE_PREFIX = "tovi.browser-task-lease:";

type LeaseRecord = {
  owner: string;
  expiresAt: number;
};

function parseLease(raw: string | null): LeaseRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
    return typeof parsed.owner === "string" && typeof parsed.expiresAt === "number"
      ? { owner: parsed.owner, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export async function withBrowserTaskLease<T>(
  name: string,
  ttlMs: number,
  task: () => Promise<T>
): Promise<{ acquired: boolean; value?: T }> {
  if (typeof window === "undefined") return { acquired: false };

  const locks = (
    navigator as Navigator & {
      locks?: {
        request: <R>(
          name: string,
          options: { ifAvailable: true },
          callback: (lock: unknown | null) => Promise<R>
        ) => Promise<R>;
      };
    }
  ).locks;
  if (locks) {
    return locks.request(`tovi:${name}`, { ifAvailable: true }, async (lock) =>
      lock ? { acquired: true, value: await task() } : { acquired: false }
    );
  }

  const key = `${LEASE_PREFIX}${name}`;
  const owner = crypto.randomUUID();
  const now = Date.now();
  try {
    const current = parseLease(window.localStorage.getItem(key));
    if (current && current.expiresAt > now) return { acquired: false };
    window.localStorage.setItem(key, JSON.stringify({ owner, expiresAt: now + ttlMs }));
    const confirmed = parseLease(window.localStorage.getItem(key));
    if (confirmed?.owner !== owner) return { acquired: false };
    try {
      return { acquired: true, value: await task() };
    } finally {
      if (parseLease(window.localStorage.getItem(key))?.owner === owner) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    return { acquired: true, value: await task() };
  }
}
