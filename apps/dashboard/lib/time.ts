const minValidDateMs = Date.UTC(2005, 0, 1, 0, 0, 0, 0);
const maxFutureSkewMs = 5 * 60 * 1_000;
const warnedInvalidValues = new Set<string>();

function warnInvalidOnce(value: unknown): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  const key = String(value);
  if (warnedInvalidValues.has(key)) {
    return;
  }
  warnedInvalidValues.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[time] invalid time value received: ${key}`);
}

function parseDateValue(value?: string | number | null): Date | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizeEpoch = (epoch: number): Date => {
    const epochMs = epoch < 1_000_000_000_000 ? epoch * 1_000 : epoch;
    return new Date(epochMs);
  };

  let date: Date;
  if (typeof value === "number") {
    date = normalizeEpoch(value);
  } else {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      date = normalizeEpoch(Number(trimmed));
    } else {
      date = new Date(trimmed);
    }
  }

  const timestamp = date.getTime();
  if (Number.isNaN(timestamp) || timestamp < minValidDateMs || timestamp > Date.now() + maxFutureSkewMs) {
    warnInvalidOnce(value);
    return null;
  }

  return date;
}

export function formatRelative(value?: string | number | null): string {
  const date = parseDateValue(value);
  if (!date) {
    return "-";
  }

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / (60 * 1_000));
  const hours = Math.floor(diffMs / (60 * 60 * 1_000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1_000));

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }

  return "Just now";
}

// Same time buckets as formatRelative but without the trailing "ago",
// for captions that already supply their own preposition — e.g.
// "quiet for 99d" rather than the ungrammatical "quiet for 99d ago"
// (#436 R-0058).
export function formatDuration(value?: string | number | null): string {
  const date = parseDateValue(value);
  if (!date) {
    return "-";
  }

  const diffMs = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diffMs / (60 * 1_000));
  const hours = Math.floor(diffMs / (60 * 60 * 1_000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1_000));

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }

  return "moments";
}

export function formatClock(value?: string | number | null): string {
  const date = parseDateValue(value);
  if (!date) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
