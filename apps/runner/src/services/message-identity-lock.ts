const messageIdentityTails = new Map<string, Promise<void>>();

export async function withMessageIdentityLock<T>(
  messageId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = messageIdentityTails.get(messageId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  messageIdentityTails.set(messageId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (messageIdentityTails.get(messageId) === current) {
      messageIdentityTails.delete(messageId);
    }
  }
}

export async function withMessageIdentityLocks<T>(
  messageIds: string[],
  task: () => Promise<T>
): Promise<T> {
  const ids = [...new Set(messageIds)].sort();
  const run = (index: number): Promise<T> =>
    index === ids.length
      ? task()
      : withMessageIdentityLock(ids[index]!, () => run(index + 1));
  return run(0);
}
