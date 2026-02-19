const TEMPORARY_PREFIXES = [
  "linkedin-fallback:",
  "linkedin-temp:",
  "linkedin-smoke:",
  "temp:",
  "tmp:",
  "fallback:",
  "unresolved:"
];

function clean(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeLinkedInThreadIdToken(value: string): string | null {
  const trimmed = clean(value).replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }
  return decodeURIComponent(trimmed);
}

export function extractLinkedInThreadIdFromUrl(url: string): string | null {
  const raw = clean(url);
  if (!raw) {
    return null;
  }

  const parse = (value: string): URL | null => {
    try {
      return new URL(value, "https://www.linkedin.com");
    } catch {
      return null;
    }
  };

  const parsed = parse(raw);
  if (!parsed) {
    return null;
  }

  const threadMatch = parsed.pathname.match(/\/messaging\/thread\/([^/?#]+)/i);
  if (threadMatch?.[1]) {
    return normalizeLinkedInThreadIdToken(threadMatch[1]);
  }

  const conversationId = parsed.searchParams.get("conversationId") ?? parsed.searchParams.get("conversationUrn");
  if (conversationId) {
    const fromUrn = extractStableLinkedInUrn(conversationId);
    if (fromUrn) {
      return fromUrn;
    }
    return normalizeLinkedInThreadIdToken(conversationId);
  }

  return null;
}

export function extractStableLinkedInUrn(raw: string): string | null {
  const text = clean(raw);
  if (!text) {
    return null;
  }

  const decoded = (() => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  })();

  const urnMatch = decoded.match(/(urn:li:(?:msg_thread|fs_conversation):[a-z0-9:_-]+)/i);
  if (!urnMatch?.[1]) {
    return null;
  }
  return urnMatch[1].toLowerCase();
}

export function isTemporaryLinkedInId(id: string): boolean {
  const normalized = clean(id).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (TEMPORARY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (/^linkedin thread \d+$/i.test(normalized)) {
    return true;
  }
  return false;
}

function normalizeFromRawId(value: string | undefined): string | null {
  const raw = clean(value);
  if (!raw || isTemporaryLinkedInId(raw)) {
    return null;
  }

  if (raw.toLowerCase().startsWith("linkedin-href:")) {
    return normalizeFromRawId(raw.slice("linkedin-href:".length));
  }

  if (raw.toLowerCase().startsWith("linkedin-urn:")) {
    return normalizeFromRawId(raw.slice("linkedin-urn:".length));
  }

  const fromUrl = extractLinkedInThreadIdFromUrl(raw);
  if (fromUrl) {
    return fromUrl;
  }

  const fromUrn = extractStableLinkedInUrn(raw);
  if (fromUrn) {
    return fromUrn;
  }

  return raw;
}

export function normalizeCanonicalLinkedInThreadId(input: {
  platformThreadId?: string;
  threadUrl?: string;
  activeKey?: string;
}): string | null {
  const fromUrl = normalizeFromRawId(input.threadUrl);
  if (fromUrl) {
    return fromUrl;
  }

  const fromActiveKey = normalizeFromRawId(input.activeKey);
  if (fromActiveKey) {
    return fromActiveKey;
  }

  const fromPlatformThreadId = normalizeFromRawId(input.platformThreadId);
  if (fromPlatformThreadId) {
    return fromPlatformThreadId;
  }

  return null;
}

export function buildTemporaryCandidateId(input: {
  displayName: string;
  preview: string;
  listTimestamp: string;
  rowIndex?: number;
}): string {
  const displayName = clean(input.displayName).toLowerCase();
  const preview = clean(input.preview).toLowerCase();
  const timestampSalt = clean(input.listTimestamp).toLowerCase();
  const baseParts = [displayName, preview].filter((entry) => entry.length > 0);
  let signature = baseParts.join("|");
  if (!signature && timestampSalt) {
    signature = `ts:${timestampSalt}`;
  } else if (baseParts.length === 1 && timestampSalt) {
    signature = `${baseParts[0]}|ts:${timestampSalt}`;
  } else if (!signature) {
    signature = "missing-temp-candidate";
  }
  return `linkedin-temp:${hashText(signature)}`;
}
