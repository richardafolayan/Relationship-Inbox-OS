const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function buildDate(year: number, monthIndex: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

export function parseLinkedInListTimestamp(text: string, now: Date): Date | null {
  const normalized = clean(text);
  if (!normalized || normalized === "-") {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (lowered === "yesterday") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    const parsedIso = new Date(normalized);
    return Number.isNaN(parsedIso.getTime()) ? null : parsedIso;
  }

  const timeMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (timeMatch) {
    const [, rawHour, rawMinute, meridiem] = timeMatch;
    let hour = Number(rawHour) % 12;
    if ((meridiem ?? "").toUpperCase() === "PM") {
      hour += 12;
    }
    const minute = Number(rawMinute);
    const candidate = buildDate(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (candidate.getTime() > now.getTime()) {
      return buildDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
    }
    return candidate;
  }

  const monthDayYearMatch = normalized.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthDayYearMatch) {
    const [, monthName, rawDay, rawYear] = monthDayYearMatch;
    const monthIndex = MONTHS[(monthName ?? "").toLowerCase()];
    if (typeof monthIndex !== "number") {
      return null;
    }
    return buildDate(Number(rawYear), monthIndex, Number(rawDay));
  }

  const monthDayMatch = normalized.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const [, monthName, rawDay] = monthDayMatch;
    const monthIndex = MONTHS[(monthName ?? "").toLowerCase()];
    if (typeof monthIndex !== "number") {
      return null;
    }
    const day = Number(rawDay);
    let year = now.getFullYear();
    let candidate = buildDate(year, monthIndex, day);
    if (candidate.getTime() > now.getTime()) {
      year -= 1;
      candidate = buildDate(year, monthIndex, day);
    }
    return candidate;
  }

  return null;
}
