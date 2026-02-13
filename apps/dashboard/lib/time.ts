export function formatRelative(value?: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);

  const minutes = Math.floor(abs / (60 * 1000));
  const hours = Math.floor(abs / (60 * 60 * 1000));
  const days = Math.floor(abs / (24 * 60 * 60 * 1000));

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

export function formatClock(value?: string | null): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
